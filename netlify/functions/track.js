const fetch = require('node-fetch');

// Define headers that allow any website to access this function
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async function(event, context) {
    // Immediately handle pre-flight requests for CORS
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify({ message: 'OPTIONS request successful' })
        };
    }

    // Only allow POST requests
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers: corsHeaders, body: 'Method Not Allowed' };
    }

    const { trackingNumber } = JSON.parse(event.body);
    const MAERSK_KEY = process.env.MAERSK_API_CONSUMER_KEY;
    const MAERSK_SECRET = process.env.MAERSK_API_CONSUMER_SECRET;

    // --- 1. Get Access Token ---
    const tokenUrl = 'https://api.maersk.com/v2/oauth2/token';
    const authString = Buffer.from(`${MAERSK_KEY}:${MAERSK_SECRET}`).toString('base64');

    let accessToken;
    try {
        const tokenResponse = await fetch(tokenUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': `Basic ${authString}`
            },
            body: 'grant_type=client_credentials'
        });
        const tokenData = await tokenResponse.json();
        if (!tokenData.access_token) throw new Error('Authentication failed');
        accessToken = tokenData.access_token;
    } catch (error) {
        return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Could not authenticate with carrier. Check API keys.' }) };
    }

    // --- 2. Get Tracking Info ---
    const trackingApiUrl = `https://api.maersk.com/track-and-trace-private/events?transportDocumentReference=${trackingNumber}`;
    try {
        const trackingResponse = await fetch(trackingApiUrl, {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });

        if (!trackingResponse.ok) {
            const errorBody = await trackingResponse.text();
            return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: 'Tracking information not found for that number.' }) };
        }

        const trackingData = await trackingResponse.json();
        
        // --- 3. Format and Return Data ---
        const latest_event = trackingData[0] || {};
        const current_status = latest_event.shipmentEventTypeCode || 'Status Unavailable';
        const formatted_response = {
            status: current_status,
            events: trackingData.map(event => ({
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
