const fetch = require('node-fetch');
const { URLSearchParams } = require('url');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async function(event, context) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: 'Success' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: 'Method Not Allowed' };
  }

  const { trackingNumber } = JSON.parse(event.body);
  const MAERSK_KEY = process.env.MAERSK_API_CONSUMER_KEY;
  const MAERSK_SECRET = process.env.MAERSK_API_CONSUMER_SECRET;

  // --- PART 1 & 2: AUTHENTICATION AND FETCH (No changes) ---
  const tokenUrl = 'https://api.maersk.com/customer-identity/oauth/v2/access_token';
  let accessToken;
  try {
    const formBody = new URLSearchParams();
    formBody.append('grant_type', 'client_credentials');
    formBody.append('client_id', MAERSK_KEY);
    formBody.append('client_secret', MAERSK_SECRET);
    const tokenResponse = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Consumer-Key': MAERSK_KEY },
      body: formBody.toString()
    });
    const tokenData = await tokenResponse.json();
    accessToken = tokenData.access_token || tokenData.token;
    if (!accessToken) throw new Error(`No access_token in OAuth response`);
  } catch (error) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: `Authentication failed. Details: ${error.message}` }) };
  }

  const trackingApiUrl = `https://api.maersk.com/track-and-trace-private/events?transportDocumentReference=${trackingNumber}`;
  try {
    const trackingResponse = await fetch(trackingApiUrl, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Consumer-Key': MAERSK_KEY }
    });
    if (!trackingResponse.ok) {
      const errorText = await trackingResponse.text();
      return { statusCode: trackingResponse.status, headers: corsHeaders, body: JSON.stringify({ error: `Maersk API Error. Raw response: ${errorText}` }) };
    }
    const trackingData = await trackingResponse.json();

    // --- PART 3: FORMAT RESPONSE (FINAL POLISHED VERSION) ---
    
    // Dictionaries for translating event codes remain the same.
    const shipmentEventCodes = { 'RECE': 'Received', 'DRFT': 'Drafted', 'PENA': 'Pending Approval', 'PENU': 'Pending Update', 'REJE': 'Rejected', 'APPR': 'Approved', 'ISSU': 'Issued', 'SURR': 'Surrendered', 'SUBM': 'Submitted', 'VOID': 'Void', 'CONF': 'Confirmed', 'REQS': 'Requested', 'CMPL': 'Completed', 'HOLD': 'On Hold', 'RELS': 'Released' };
    const transportEventCodes = { 'ARRI': 'Arrived', 'DEPA': 'Departed' };
    const equipmentEventCodes = { 'LOAD': 'Loaded', 'DISC': 'Discharged', 'GTIN': 'Gated In', 'GTOT': 'Gated Out', 'STUF': 'Stuffed', 'STRP': 'Stripped', 'PICK': 'Pick-up', 'DROP': 'Drop-off', 'RSEA': 'Resealed', 'RMVD': 'Removed', 'INSP': 'Inspected' };

    const formatLocation = (loc) => {
      if (!loc) return 'Location not provided';
      const parts = [loc.locationName, loc.address?.cityName, loc.address?.country].filter(Boolean);
      return parts.length > 0 ? parts.join(', ') : 'Location details unavailable';
    };

    // UPDATED: Sort events by date to find the *true* latest event.
    const sortedEvents = (trackingData.events || []).sort((a, b) => new Date(b.eventCreatedDateTime) - new Date(a.eventCreatedDateTime));
    const latestActualEvent = sortedEvents.find(e => e.eventClassifierCode === 'ACT') || sortedEvents[0] || {};
    
    let current_status = 'Status Unavailable';
    if (latestActualEvent.eventType) {
        if (latestActualEvent.eventType === 'SHIPMENT') current_status = shipmentEventCodes[latestActualEvent.shipmentEventTypeCode] || latestActualEvent.shipmentEventTypeCode;
        else if (latestActualEvent.eventType === 'TRANSPORT') current_status = transportEventCodes[latestActualEvent.transportEventTypeCode] || latestActualEvent.transportEventTypeCode;
        else if (latestActualEvent.eventType === 'EQUIPMENT') current_status = equipmentEventCodes[latestActualEvent.equipmentEventTypeCode] || latestActualEvent.equipmentEventTypeCode;
    }

    const formatted_response = {
      status: current_status,
      // Use the sorted array for the final output
      events: sortedEvents.map(event => {
        let description = event.eventType;
        let location = 'Location not provided';

        if (event.eventType === 'SHIPMENT') {
          description = shipmentEventCodes[event.shipmentEventTypeCode] || event.shipmentEventTypeCode;
          // NEW: Add document info for more context.
          if(event.documentTypeCode && event.documentID) {
            description += ` (${event.documentTypeCode}: ${event.documentID})`;
          }
        } 
        else if (event.eventType === 'TRANSPORT') {
          description = transportEventCodes[event.transportEventTypeCode] || event.transportEventTypeCode;
          // NEW: Add vessel name if it exists.
          const vesselName = event.transportCall?.vessel?.vesselName;
          if (vesselName) {
            description += ` (on vessel ${vesselName})`;
          }
          location = formatLocation(event.transportCall?.location);
        } 
        else if (event.eventType === 'EQUIPMENT') {
          description = equipmentEventCodes[event.equipmentEventTypeCode] || event.equipmentEventTypeCode;
          // UPDATED: Correctly get location for equipment events.
          location = formatLocation(event.eventLocation);
        }

        return {
          date: event.eventCreatedDateTime || 'N/A',
          description: `${description} (${event.eventClassifierCode})`,
          location: location,
        };
      })
    };

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify(formatted_response)
    };

  } catch (error) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: `An internal error occurred: ${error.message}` })
    };
  }
};
