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

  // --- PART 1: AUTHENTICATION (No changes needed) ---
  const tokenUrl = 'https://api.maersk.com/customer-identity/oauth/v2/access_token';
  let accessToken;

  try {
    const formBody = new URLSearchParams();
    formBody.append('grant_type', 'client_credentials');
    formBody.append('client_id', MAERSK_KEY);
    formBody.append('client_secret', MAERSK_SECRET);

    const tokenResponse = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Consumer-Key': MAERSK_KEY
      },
      body: formBody.toString()
    });

    const tokenData = await tokenResponse.json();
    accessToken = tokenData.access_token || tokenData.token;

    if (!accessToken) {
      throw new Error(`No access_token in OAuth response: ${JSON.stringify(tokenData)}`);
    }

  } catch (error) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: `Authentication failed. Details: ${error.message}` })
    };
  }

  // --- PART 2: FETCH TRACKING DATA (No changes needed) ---
  const trackingApiUrl = `https://api.maersk.com/track-and-trace-private/events?transportDocumentReference=${trackingNumber}`;

  try {
    const trackingResponse = await fetch(trackingApiUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Consumer-Key': MAERSK_KEY
      }
    });

    if (!trackingResponse.ok) {
      const errorText = await trackingResponse.text();
      return {
        statusCode: trackingResponse.status,
        headers: corsHeaders,
        body: JSON.stringify({ error: `Maersk API Error. Raw response: ${errorText}` })
      };
    }

    const trackingData = await trackingResponse.json();

    // --- PART 3: FORMAT RESPONSE (FINAL VERSION) ---
    
    // Dictionaries for translating event codes based on the new documentation.
    const shipmentEventCodes = { 'RECE': 'Received', 'DRFT': 'Drafted', 'PENA': 'Pending Approval', 'PENU': 'Pending Update', 'REJE': 'Rejected', 'APPR': 'Approved', 'ISSU': 'Issued', 'SURR': 'Surrendered', 'SUBM': 'Submitted', 'VOID': 'Void', 'CONF': 'Confirmed', 'REQS': 'Requested', 'CMPL': 'Completed', 'HOLD': 'On Hold', 'RELS': 'Released' };
    const transportEventCodes = { 'ARRI': 'Arrived', 'DEPA': 'Departed' };
    const equipmentEventCodes = { 'LOAD': 'Loaded', 'DISC': 'Discharged', 'GTIN': 'Gated In', 'GTOT': 'Gated Out', 'STUF': 'Stuffed', 'STRP': 'Stripped', 'PICK': 'Pick-up', 'DROP': 'Drop-off', 'RSEA': 'Resealed', 'RMVD': 'Removed', 'INSP': 'Inspected' };

    // A helper function to safely build a location string.
    const formatLocation = (loc) => {
      if (!loc) return 'Location not provided';
      const parts = [
          loc.locationName,
          loc.address?.cityName,
          loc.address?.country
      ].filter(Boolean); // filter(Boolean) removes any null or undefined parts.
      return parts.length > 0 ? parts.join(', ') : 'Location details unavailable';
    };

    // Find the latest event that is 'ACT' (Actual) to use for the main status.
    const latestActualEvent = (trackingData.events || []).find(e => e.eventClassifierCode === 'ACT') || (trackingData.events && trackingData.events[0]) || {};
    let current_status = 'Status Unavailable';
    if (latestActualEvent.eventType === 'SHIPMENT') {
        current_status = shipmentEventCodes[latestActualEvent.shipmentEventTypeCode] || latestActualEvent.shipmentEventTypeCode;
    } else if (latestActualEvent.eventType === 'TRANSPORT') {
        current_status = transportEventCodes[latestActualEvent.transportEventTypeCode] || latestActualEvent.transportEventTypeCode;
    } else if (latestActualEvent.eventType === 'EQUIPMENT') {
        current_status = equipmentEventCodes[latestActualEvent.equipmentEventTypeCode] || latestActualEvent.equipmentEventTypeCode;
    }


    const formatted_response = {
      status: current_status,
      events: (trackingData.events || []).map(event => {
        let description = event.eventType; // Default description
        let location = 'Location not provided';

        // Check the eventType to decide how to process it.
        if (event.eventType === 'SHIPMENT') {
          description = shipmentEventCodes[event.shipmentEventTypeCode] || event.shipmentEventTypeCode;
          // Shipment events do not have a location object in the provided schema.
        } 
        else if (event.eventType === 'TRANSPORT') {
          description = transportEventCodes[event.transportEventTypeCode] || event.transportEventTypeCode;
          // Location for transport events is nested inside transportCall.
          location = formatLocation(event.transportCall?.location);
        } 
        else if (event.eventType === 'EQUIPMENT') {
          description = equipmentEventCodes[event.equipmentEventTypeCode] || event.equipmentEventTypeCode;
          // Equipment events have a top-level eventLocation object.
          location = formatLocation(event.eventLocation);
        }

        return {
          date: event.eventCreatedDateTime || 'N/A',
          description: `${description} (${event.eventClassifierCode})`, // Adding PLN, ACT, or EST for context
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
