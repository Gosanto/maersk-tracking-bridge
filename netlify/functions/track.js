const fetch = require('node-fetch');

// Standard CORS headers to allow your WordPress site to call this function
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async function(event, context) {
    // Standard pre-flight request handling
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: corsHeaders, body: 'Success' };
    }
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers: corsHeaders, body: 'Method Not Allowed' };
    }

    const { trackingNumber } = JSON.parse(event.body);
    const MAERSK_KEY = process.env.MAERSK_API_CONSUMER_KEY;
    const MAERSK_SECRET = process.env.MAERSK_API_CONSUMER_SECRET;

    // --- PART 1: AUTHENTICATION ---
    // This section follows the "Authorisation Guide" document precisely.
    const tokenUrl = 'https://api.maersk.com/v2/oauth2/token';
    const authString = Buffer.from(`${MAERSK_KEY}:${MAERSK_SECRET}`).toString('base64');

    let accessToken;
    try {
        const tokenResponse = await fetch(tokenUrl, {
            method: 'POST',
            headers: {
                // As per the Authorisation Guide, only these two headers are required.
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': `Basic ${authString}`
            },
            body: 'grant_type=client_credentials' // The required body content
        });
        
        const tokenData = await tokenResponse.json();
        
        if (!tokenData.access_token) {
            // If this fails, throw the exact error from Maersk's server.
            throw new Error(JSON.stringify(tokenData));
        }
        accessToken = tokenData.access_token;
        
    } catch (error) {
        return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: `Authentication failed. Maersk server response: ${error.message}` }) };
    }

    // --- PART 2: DATA FETCHING ---
    // This section follows the "Track & Trace Events API" specification precisely.
    const trackingApiUrl = `https://api.maersk.com/track-and-trace-private/events?transportDocumentReference=${trackingNumber}`;
    try {
        const trackingResponse = await fetch(trackingApiUrl, {
            method: 'GET',
            headers: { 
                // As per the T&T API Spec, both the Bearer token and the Consumer-Key are required.
                'Authorization': `Bearer ${accessToken}`,
                'Consumer-Key': MAERSK_KEY 
            }
        });

        if (!trackingResponse.ok) {
            return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: 'Tracking information not found for that number.' }) };
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
