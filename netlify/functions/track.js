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
const isoCodeToSize = { '45G1': "40' Dry High", '22G1': "20' Dry" };
const getIcon = (event) => {
  if (event.eventType === 'TRANSPORT') return 'vessel';
  if (['GTOT', 'GTIN', 'PICK'].includes(event.equipmentEventTypeCode)) return 'truck';
  return 'container';
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
    const trackingApiUrl = `https://api.maersk.com/track-and-trace-private/events?transportDocumentReference=${trackingNumber}&eventType=TRANSPORT,EQUIPMENT`;
    const trackingResponse = await fetch(trackingApiUrl, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Consumer-Key': MAERSK_KEY }
    });
    if (!trackingResponse.ok) throw new Error(`Maersk API Error (${trackingResponse.status})`);
    
    const trackingData = await trackingResponse.json();
    const physicalEvents = (trackingData.events || []);
    
    if (physicalEvents.length === 0) {
        return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ summary: { blNumber: trackingNumber, from: 'N/A', to: 'N/A' }, transportPlan: [] }) };
    }
    
    const sortedEvents = physicalEvents.sort((a, b) => new Date(a.eventCreatedDateTime) - new Date(b.eventCreatedDateTime));
    const lastEvent = sortedEvents[sortedEvents.length - 1];
    
    // --- DEFINITIVE "FROM" and "TO" LOGIC PER YOUR INSTRUCTIONS ---
    const getLocationFromEvent = (event) => {
        if (!event) return 'N/A';
        const loc = event.eventLocation || event.transportCall?.location;
        // Prioritize the city name, but fall back to the terminal/location name if the city is not available.
        return loc?.address?.cityName || loc?.locationName || 'N/A';
    };

    // "From" is the location of the first "LOAD" or "PICK" event.
    const fromEvent = sortedEvents.find(e => e.equipmentEventTypeCode === 'LOAD' || e.equipmentEventTypeCode === 'PICK');
    const fromLocation = getLocationFromEvent(fromEvent);

    // "To" is the location of the last "DISC" or "DROP" event.
    const toEvent = [...sortedEvents].reverse().find(e => e.equipmentEventTypeCode === 'DISC' || e.equipmentEventTypeCode === 'DROP');
    const toLocation = getLocationFromEvent(toEvent);

    const lastUpdatedDate = new Date(lastEvent.eventCreatedDateTime);
    const daysAgo = Math.round((new Date() - lastUpdatedDate) / (1000 * 60 * 60 * 24));
    const lastUpdatedText = daysAgo <= 0 ? 'Today' : `${daysAgo} day${daysAgo === 1 ? '' : 's'} ago`;

    const transportPlan = sortedEvents.map(event => {
      const eventCode = event.equipmentEventTypeCode || event.transportEventTypeCode;
      let description = eventDescriptions[eventCode] || eventCode;
      let vesselInfo = null;
      if (event.eventType === 'TRANSPORT' && event.transportCall?.vessel?.vesselName) {
        vesselInfo = `${event.transportCall.vessel.vesselName} / ${event.transportCall.exportVoyageNumber}`;
      }
      const locationObj = event.eventLocation || event.transportCall?.location;
      return {
        locationName: locationObj?.locationName,
        locationDetail: locationObj?.address?.cityName && locationObj.address.cityName.toLowerCase() !== locationObj.locationName.toLowerCase() ? `${locationObj.address.cityName}, ${locationObj.address.country}` : null,
        icon: getIcon(event), description, vesselInfo, date: event.eventDateTime
      };
    });
    
    const containerEvents = sortedEvents.filter(e => e.equipmentReference);
    const uniqueContainerIds = [...new Set(containerEvents.map(e => e.equipmentReference))];
    const containers = uniqueContainerIds.map(id => {
        const lastEventForContainer = [...containerEvents].reverse().find(e => e.equipmentReference === id);
        const eventCode = lastEventForContainer.equipmentEventTypeCode;
        const lastLoc = lastEventForContainer.eventLocation || lastEventForContainer.transportCall?.location;
        const finalStatusDesc = eventDescriptions[eventCode] || eventCode;
        return {
            id, size: isoCodeToSize[lastEventForContainer.ISOEquipmentCode] || 'Standard',
            finalStatus: finalStatusDesc,
            finalLocation: lastLoc?.address ? `${lastLoc.address.cityName}, ${lastLoc.address.country}` : 'N/A',
            finalDate: lastEventForContainer.eventDateTime
        };
    });

    const finalResponse = {
      summary: { blNumber: trackingNumber, from: fromLocation, to: toLocation },
      lastUpdated: lastUpdatedText, containers, transportPlan
    };

    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(finalResponse) };

  } catch (error) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: `An internal error occurred: ${error.message}` }) };
  }
};
