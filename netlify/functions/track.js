const fetch = require('node-fetch');

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

    // --- NO MORE OAUTH STEP ---
    // We are now calling the public API directly, using the simple Consumer-Key header
    // that we already proved works with the Products API.

    // --- PART 1: DATA FETCHING (Using the Public Track & Trace Endpoint) ---
    const trackingApiUrl = `https://api.maersk.com/track-and-trace-public/events?transportDocumentReference=${trackingNumber}`;
    
    try {
        const trackingResponse = await fetch(trackingApiUrl, {
            method: 'GET',
            headers: { 
                // Using the simple, direct authentication method.
                'Consumer-Key': MAERSK_KEY 
            }
        });

        // Robust error handling to see the exact response if it fails.
        if (!trackingResponse.ok) {
            const errorText = await trackingResponse.text(); // Get the raw error text
            return { 
                statusCode: trackingResponse.status, 
                headers: corsHeaders, 
                body: JSON.stringify({ error: `Maersk API Error: ${errorText}` }) 
            };
        }

        const trackingData = await trackingResponse.json();
        
        // --- PART 2: FORMAT AND RETURN DATA ---
        const latest_event = (trackingData.events && trackingData.events[0]) || {};
        const current_status = latest_event.shipmentEventTypeCode || 'Status Unavailable';
        const formatted_response = {
            status: current_status,
            events: (trackingData.events || []).map(event => ({
                date: event.eventCreatedDateTime || 'N/A',
                // The public API has a slightly different structure, so we check for eventDescription.
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
        return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: `An internal error occurred: ${error.message}` }) };
    }
};
