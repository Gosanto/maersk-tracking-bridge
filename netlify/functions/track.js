const fetch = require('node-fetch');
// The URLSearchParams interface is native to Node.js, so no extra import is needed.

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

    // --- PART 1: AUTHENTICATION (Corrected Flow) ---
    // Using the recommended method of sending credentials in the body.
    const tokenUrl = 'https://api.maersk.com/v2/oauth2/token'; // Using the documented /v2/ endpoint first. Can be changed if needed.

    let accessToken;
    try {
        // Create the body in the 'application/x-www-form-urlencoded' format.
        const formBody = new URLSearchParams();
        formBody.append('grant_type', 'client_credentials');
        formBody.append('client_id', MAERSK_KEY);
        formBody.append('client_secret', MAERSK_SECRET);

        const tokenResponse = await fetch(tokenUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: formBody.toString()
        });
        
        const tokenData = await tokenResponse.json();
        
        if (!tokenData.access_token) {
            throw new Error(JSON.stringify(tokenData));
        }
        accessToken = tokenData.access_token;
        
    } catch (error) {
        return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: `Authentication failed. Maersk server response: ${error.message}` }) };
    }

    // --- PART 2: DATA FETCHING (Remains the same as per T&T docs) ---
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
            return { statusCode: trackingResponse.status, headers: corsHeaders, body: JSON.stringify({ error: `Tracking information not found. Status: ${trackingResponse.statusText}` }) };
        }

        const trackingData = await trackingResponse.json();
        
        // --- PART 3: FORMAT AND RETURN DATA ---
        const latest_event = (trackingData.events && trackingData.events[0]) || {};
        const current_status = latest_event.shipmentEventTypeCode || 'Status Unavailable';
        const formatted_response = {
            status: current_status,
            events: (trackingData.events || []).map(event => ({
                date: event.eventCreatedDateTime || 'N/A',
                description: event.eventDescription || 'No description',
                location: (event.eventLocation && event.eventLocation.locationName) || 'Unknown location',
            }))
        };

        return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify(formatted_response)
        };

    } catch (error) {
        return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'An error occurred while fetching tracking data.' }) };
    }
};
