const fetch = require('node-fetch');
const { URLSearchParams } = require('url');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const eventDescriptions = {
  'GTIN': 'Gate in', 'GTOT': 'Gate out Empty', 'LOAD': 'Load', 'DISC': 'Discharge',
  'PICK': 'Gate out for delivery', 'DROP': 'Empty container return',
  'DEPA': 'Vessel departure', 'ARRI': 'Vessel arrival',
};
const isoCodeToSize = { '45G1': "40' Dry High", '22G1': "20' Dry", '42G1': "40' Dry" };
const getIcon = (event) => {
  if (event.eventType === 'TRANSPORT') return 'vessel';
  if (['GTOT', 'GTIN', 'PICK'].includes(event.equipmentEventTypeCode) || event.transportCall?.modeOfTransport === 'TRUCK') return 'truck';
  return 'container';
};

const UN_LOCATION_MAP = {
    'SAJED': 'Jeddah',
    'EGPSD': 'Port Said',
    'TRKMX': 'Ambarli'
};

exports.handler = async function(event, context) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: 'Success' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: corsHeaders, body: 'Method Not Allowed' };

  const { trackingNumber } = JSON.parse(event.body);
  const MAERSK_KEY = process.env.MAERSK_API_CONSUMER_KEY;
  const MAERSK_SECRET = process.env.MAERSK_API_CONSUMER_SECRET;
  
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
    if (!accessToken) throw new Error(`No access_token`);
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
    const allEvents = (trackingData.events || []).sort((a, b) => new Date(a.eventCreatedDateTime) - new Date(b.eventCreatedDateTime));
    
    if (allEvents.length === 0) {
        return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ summary: { blNumber: trackingNumber } }) };
    }
    
    // UPDATED: Filter for ACTUAL physical events for the transport plan
    const actualPhysicalEvents = allEvents.filter(e => e.eventType !== 'SHIPMENT' && e.eventClassifierCode === 'ACT');
    const lastPhysicalEvent = actualPhysicalEvents.length > 0 ? actualPhysicalEvents[actualPhysicalEvents.length - 1] : null;

    // --- Summary Block Logic (no changes) ---
    const fromEvent = allEvents.find(e => e.eventType === 'TRANSPORT' && e.transportCall?.modeOfTransport === 'TRUCK' && e.transportEventTypeCode === 'DEPA');
    const fromLocation = fromEvent?.transportCall?.location?.locationName || 'N/A';
    
    const toEvent = [...allEvents].reverse().find(e => e.eventType === 'TRANSPORT' && e.transportCall?.modeOfTransport === 'VESSEL' && e.transportEventTypeCode === 'ARRI');
    const destinationUNCode = toEvent?.transportCall?.UNLocationCode;
    const toLocation = UN_LOCATION_MAP[destinationUNCode] || toEvent?.transportCall?.location?.locationName || 'N/A';
    
    const lastUpdatedDate = new Date(lastPhysicalEvent.eventCreatedDateTime);
    const daysAgo = Math.round((new Date() - lastUpdatedDate) / (1000 * 60 * 60 * 24));
    const lastUpdatedText = daysAgo <= 0 ? 'Today' : `${daysAgo} day${daysAgo === 1 ? '' : 's'} ago`;

    // --- Container Details (no changes) ---
    const containerEvents = actualPhysicalEvents.filter(e => e.equipmentReference);
    const uniqueContainerIds = [...new Set(containerEvents.map(e => e.equipmentReference))];
    const containers = uniqueContainerIds.map(id => {
        const physicalForContainer = actualPhysicalEvents.filter(e => e.equipmentReference === id);
        const lastActualEventForContainer = physicalForContainer[physicalForContainer.length - 1];
        const etaEvent = [...allEvents].reverse().find(e => e.transportEventTypeCode === 'ARRI' && e.eventClassifierCode === 'EST');
        const etaDate = etaEvent?.eventDateTime || lastActualEventForContainer?.eventDateTime || null;
        const lastLoc = lastActualEventForContainer?.eventLocation || lastActualEventForContainer?.transportCall?.location;
        const eventCode = lastActualEventForContainer?.equipmentEventTypeCode || lastActualEventForContainer?.transportEventTypeCode;
        let latestEventDescription = eventDescriptions[eventCode] || eventCode;
        if (lastActualEventForContainer?.eventType === 'EQUIPMENT' && eventCode === 'GTIN' && lastActualEventForContainer?.emptyIndicatorCode === 'EMPTY') {
            latestEventDescription = 'Empty container return';
        }
        const latestEventLocationUNCode = lastLoc?.UNLocationCode;
        const latestEventLocation = UN_LOCATION_MAP[latestEventLocationUNCode] || lastLoc?.locationName || 'N/A';
        return {
            id, size: isoCodeToSize[lastActualEventForContainer?.ISOEquipmentCode] || 'Standard',
            eta: { date: etaDate, label: "Estimated arrival date" },
            latestEvent: {
                description: latestEventDescription,
                location: latestEventLocation,
                date: lastActualEventForContainer?.eventDateTime
            }
        };
    });
    
    // --- Transport Plan (with smarter descriptions) ---
    const transportPlan = actualPhysicalEvents.map(event => {
      const eventCode = event.equipmentEventTypeCode || event.transportEventTypeCode;
      let description = eventDescriptions[eventCode] || eventCode;
      
      // Add more descriptive context for gate out events
      if (eventCode === 'GTOT' && event.emptyIndicatorCode === 'LADEN') {
        description = 'Gate out for delivery';
      }

      let vesselInfo = null;
      if (event.eventType === 'TRANSPORT' && event.transportCall?.vessel?.vesselName) {
        vesselInfo = `${event.transportCall.vessel.vesselName} / ${event.transportCall.exportVoyageNumber}`;
      }
      const locationObj = event.eventLocation || event.transportCall?.location;
      
      const primaryLocation = locationObj?.address?.cityName || locationObj?.locationName;
      const secondaryLocation = locationObj?.address?.cityName ? locationObj.locationName : null;

      return {
        primaryLocation: primaryLocation,
        secondaryLocation: secondaryLocation,
        icon: getIcon(event), description, vesselInfo, date: event.eventDateTime
      };
    });

    const finalResponse = {
      summary: { blNumber: trackingNumber, from: fromLocation, to: toLocation },
      containers: containers,
      transportPlan: transportPlan
    };

    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(finalResponse) };

  } catch (error) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: `An internal error occurred: ${error.message}` }) };
  }
};
