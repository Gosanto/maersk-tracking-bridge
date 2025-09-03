const fetch = require('node-fetch');
const { URLSearchParams } = require('url');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
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
        return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ message: "No events found." }) };
    }

    // Helper to extract a clean location object from an event
    const getLocationObject = (event) => {
        if (!event) return null;
        const loc = event.eventLocation || event.transportCall?.location;
        if (!loc) return null;
        return {
            locationName: loc.locationName || null,
            cityName: loc.address?.cityName || null,
            stateRegion: loc.address?.stateRegion || null,
            country: loc.address?.country || null,
            UNLocationCode: loc.UNLocationCode || null
        };
    };

    // --- Find each candidate event ---

    // Candidate 1: Last Vessel Arrival
    const lastTransportArrival = [...allEvents].reverse().find(e => e.transportEventTypeCode === 'ARRI');

    // Candidate 2: Last Equipment Discharge
    const lastEquipmentDischarge = [...allEvents].reverse().find(e => e.equipmentEventTypeCode === 'DISC');
    
    // Candidate 3: Last Equipment Drop-off
    const lastEquipmentDropOff = [...allEvents].reverse().find(e => e.equipmentEventTypeCode === 'DROP');

    // Candidate 4: Planned Arrival at Customer Location
    const plannedArrivalAtCustomer = [...allEvents].reverse().find(e => 
        e.eventType === 'TRANSPORT' &&
        e.eventClassifierCode === 'PLN' &&
        e.transportEventTypeCode === 'ARRI' &&
        e.transportCall?.facilityTypeCode === 'CLOC'
    );
    
    // Build a clean report
    const report = {
        lastVesselArrival: getLocationObject(lastTransportArrival),
        lastEquipmentDischarge: getLocationObject(lastEquipmentDischarge),
        lastEquipmentDropOff: getLocationObject(lastEquipmentDropOff),
        plannedArrivalAtCustomer: getLocationObject(plannedArrivalAtCustomer),
    };

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify(report, null, 2) 
    };

  } catch (error) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: `An internal error occurred: ${error.message}` }, null, 2) };
  }
};
