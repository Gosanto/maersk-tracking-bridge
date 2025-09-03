const fetch = require('node-fetch');
const { URLSearchParams } = require('url');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

// --- DICTIONARIES to translate API data into Maersk's front-end language ---
const eventDescriptions = {
  // EquipmentEvent Codes
  'GTIN': 'Gate in', 'GTOT': 'Gate out', 'LOAD': 'Load', 'DISC': 'Discharge', 'STUF': 'Stuffed', 'STRP': 'Stripped', 'PICK': 'Pick-up for delivery', 'DROP': 'Empty container return',
  // TransportEvent Codes
  'DEPA': 'Vessel departure', 'ARRI': 'Vessel arrival',
  // ShipmentEvent Codes
  'RECE': 'Received for shipment', 'DRFT': 'Draft B/L created', 'CONF': 'Booking confirmed', 'ISSU': 'B/L issued', 'PENA': 'Pending approval'
};

const isoCodeToSize = {
  '45G1': "40' Dry High", '22G1': "20' Dry", '42G1': "40' Dry", '45R1': "40' Reefer High",
  // Add more ISO codes as needed
};

const getIcon = (event) => {
  if (event.eventType === 'TRANSPORT' || event.transportCall?.modeOfTransport === 'VESSEL') return 'vessel';
  if (event.transportCall?.modeOfTransport === 'TRUCK' || event.equipmentEventTypeCode === 'GTOT' || event.equipmentEventTypeCode === 'GTIN') return 'truck';
  return 'container';
};


exports.handler = async function(event, context) {
  // --- Standard boilerplate for OPTIONS/POST checks ---
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: 'Success' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: corsHeaders, body: 'Method Not Allowed' };

  const { trackingNumber } = JSON.parse(event.body);
  const MAERSK_KEY = process.env.MAERSK_API_CONSUMER_KEY;
  const MAERSK_SECRET = process.env.MAERSK_API_CONSUMER_SECRET;
  
  // --- PART 1 & 2: AUTH and FETCH (No changes) ---
  let accessToken;
  try {
    const formBody = new URLSearchParams();
    formBody.append('grant_type', 'client_credentials');
    formBody.append('client_id', MAERSK_KEY);
    formBody.append('client_secret', MAERSK_SECRET);
    const tokenResponse = await fetch('https://api.maersk.com/customer-identity/oauth/v2/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Consumer-Key': MAERSK_KEY },
      body: formBody.toString()
    });
    const tokenData = await tokenResponse.json();
    accessToken = tokenData.access_token || tokenData.token;
    if (!accessToken) throw new Error(`No access_token in OAuth response`);
  } catch (error) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: `Authentication failed: ${error.message}` }) };
  }

  try {
    const trackingApiUrl = `https://api.maersk.com/track-and-trace-private/events?transportDocumentReference=${trackingNumber}`;
    const trackingResponse = await fetch(trackingApiUrl, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Consumer-Key': MAERSK_KEY }
    });
    if (!trackingResponse.ok) throw new Error(`Maersk API Error (${trackingResponse.status})`);
    const trackingData = await trackingResponse.json();

    // --- PART 3: BUILD THE DETAILED RESPONSE OBJECT ---
    const allEvents = (trackingData.events || []);
    if (allEvents.length === 0) return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ summary: { blNumber: trackingNumber }, transportPlan: [] }) };

    const sortedEvents = allEvents.sort((a, b) => new Date(a.eventCreatedDateTime) - new Date(b.eventCreatedDateTime));
    const lastEvent = sortedEvents[sortedEvents.length - 1];
    
    // Infer From/To by finding the first and last locations with a city name
    const firstLocationEvent = sortedEvents.find(e => (e.eventLocation?.address?.cityName || e.transportCall?.location?.address?.cityName));
    const lastLocationEvent = [...sortedEvents].reverse().find(e => (e.eventLocation?.address?.cityName || e.transportCall?.location?.address?.cityName));
    const fromLocation = firstLocationEvent?.eventLocation?.address?.cityName || firstLocationEvent?.transportCall?.location?.address?.cityName || 'N/A';
    const toLocation = lastLocationEvent?.eventLocation?.address?.cityName || lastLocationEvent?.transportCall?.location?.address?.cityName || 'N/A';

    // Calculate "Last updated"
    const lastUpdatedDate = new Date(lastEvent.eventCreatedDateTime);
    const daysAgo = Math.round((new Date() - lastUpdatedDate) / (1000 * 60 * 60 * 24));
    const lastUpdatedText = daysAgo === 0 ? 'Today' : `${daysAgo} day${daysAgo > 1 ? 's' : ''} ago`;

    // Process all events into a clean transport plan
    const transportPlan = sortedEvents.map(event => {
      const eventCode = event.equipmentEventTypeCode || event.transportEventTypeCode || event.shipmentEventTypeCode;
      let description = eventDescriptions[eventCode] || eventCode || event.eventType;
      
      let vesselInfo = null;
      if(event.eventType === 'TRANSPORT' && event.transportCall?.vessel?.vesselName) {
        vesselInfo = `${event.transportCall.vessel.vesselName} / ${event.transportCall.exportVoyageNumber}`;
      }

      const locationObj = event.eventLocation || event.transportCall?.location;
      
      return {
        locationName: locationObj?.locationName,
        locationDetail: locationObj?.address?.cityName ? `${locationObj.address.cityName}, ${locationObj.address.country}` : null,
        icon: getIcon(event),
        description: description,
        vesselInfo: vesselInfo,
        date: event.eventDateTime // Use the local event time
      };
    });
    
    // Find unique containers and their details
    const containerEvents = sortedEvents.filter(e => e.equipmentReference);
    const uniqueContainerIds = [...new Set(containerEvents.map(e => e.equipmentReference))];
    const containers = uniqueContainerIds.map(id => {
        const lastEventForContainer = [...containerEvents].reverse().find(e => e.equipmentReference === id);
        const eventCode = lastEventForContainer.equipmentEventTypeCode;
        const lastLoc = lastEventForContainer.eventLocation || lastEventForContainer.transportCall?.location;
        return {
            id: id,
            size: isoCodeToSize[lastEventForContainer.ISOEquipmentCode] || 'Standard',
            finalStatus: eventDescriptions[eventCode] || eventCode,
            finalLocation: lastLoc?.address ? `${lastLoc.address.cityName}, ${lastLoc.address.country}` : 'N/A',
            finalDate: lastEventForContainer.eventDateTime
        };
    });

    const finalResponse = {
      summary: { blNumber: trackingNumber, from: fromLocation, to: toLocation },
      lastUpdated: lastUpdatedText,
      containers: containers,
      transportPlan: transportPlan.reverse() // Show most recent first
    };

    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(finalResponse) };

  } catch (error) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: `An internal error occurred: ${error.message}` }) };
  }
};
