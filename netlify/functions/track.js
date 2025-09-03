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

  // --- PART 1: AUTHENTICATION (Private OAuth Flow with Robust Error Handling) ---
  
  // CORRECTED: Changed v2 to v1 as per Maersk documentation
  const tokenUrl = 'https://api.maersk.com/v1/oauth2/token'; 
  let accessToken;

  try {
    const formBody = new URLSearchParams();
    formBody.append('grant_type', 'client_credentials');
    formBody.append('client_id', MAERSK_KEY);
    formBody.append('client_secret', MAERSK_SECRET);

    const tokenResponse = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody.toString()
    });

    let tokenData;
    try {
      tokenData = await tokenResponse.json();
    } catch (err) {
      const text = await tokenResponse.text();
      throw new Error(`Failed to parse OAuth JSON. Raw response: ${text}`);
    }

    if (!tokenData.access_token) {
      throw new Error(`No access_token in OAuth response: ${JSON.stringify(tokenData)}`);
    }

    accessToken = tokenData.access_token;

  } catch (error) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        error: `Authentication failed. Ensure your private Track & Trace app is whitelisted for OAuth v2. Details: ${error.message}`
      })
    };
  }

  // --- PART 2: FETCH TRACKING DATA (Private Endpoint) ---
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
        body: JSON.stringify({
          error: `Maersk Private API Error. Ensure your account is whitelisted. Raw response: ${errorText}`
        })
      };
    }

    const trackingData = await trackingResponse.json();

    // --- PART 3: FORMAT RESPONSE ---
    const latest_event = (trackingData.events && trackingData.events[0]) || {};
    const current_status = latest_event.shipmentEventTypeCode || 'Status Unavailable';
    const formatted_response = {
      status: current_status,
      events: (trackingData.events || []).map(event => ({
        date: event.eventCreatedDateTime || 'N/A',
        description: event.eventDescription || event.eventType || 'No description',
        location: (event.eventLocation && event.eventLocation.locationName) || 'Unknown location',
      }))
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
      body: JSON.stringify({
        error: `An internal error occurred while fetching tracking data: ${error.message}`
      })
    };
  }
};
