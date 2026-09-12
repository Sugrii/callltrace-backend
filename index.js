const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();

// Enable CORS for frontend web requests
app.use(cors({ origin: true }));
app.use(express.json());

// Initialize Firebase Admin SDK
// Supports both Environment Variables (Vercel Production) and local JSON file fallback
if (!admin.apps.length) {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        // Vercel deployment mode (Service Account key passed as Base64 string or raw JSON string)
        const serviceAccount = JSON.parse(
            Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString('utf8')
        );
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
    } else {
        // Local development fallback
        try {
            const serviceAccount = require('../serviceAccountKey.json');
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
        } catch (err) {
            console.error('Firebase Initialization Error: Missing credentials. Set FIREBASE_SERVICE_ACCOUNT env variable.');
        }
    }
}

const db = admin.firestore();
const CALL_LOGS_COLLECTION = 'call_logs';

/**
 * Telecom Provider Resolver
 */
function resolveNetworkProvider(phone) {
    if (!phone) return 'Unknown Operator';
    const cleanNumber = phone.replace(/[^0-9+]/g, '');

    const prefixMap = [
        { name: 'MTN Ghana', prefixes: ['024', '054', '055', '059', '025', '053', '+23324', '+23354', '+23355', '+23359', '+23325', '+23353'] },
        { name: 'Telecel Ghana', prefixes: ['020', '050', '+23320', '+23350'] },
        { name: 'AT Ghana', prefixes: ['027', '057', '026', '056', '+23327', '+23357', '+23326', '+23356'] },
        { name: 'Glo Ghana', prefixes: ['023', '+23323'] }
    ];

    for (const item of prefixMap) {
        if (item.prefixes.some(prefix => cleanNumber.startsWith(prefix))) {
            return item.name;
        }
    }

    if (cleanNumber.startsWith('+') && !cleanNumber.startsWith('+233')) {
        return 'International Carrier';
    }

    return 'Standard Mobile Carrier';
}

/**
 * GET /api/call-logs
 * Retrieves call history for a target phone number (Default: Past 30 days)
 */
app.get('/api/call-logs', async (req, res) => {
    try {
        const { phoneNumber, startDate, endDate } = req.query;

        if (!phoneNumber) {
            return res.status(400).json({ error: 'Query parameter "phoneNumber" is required.' });
        }

        const cleanPhone = phoneNumber.replace(/[^0-9+]/g, '');

        // Default to past 30 days if startDate is not supplied
        const end = endDate ? new Date(endDate) : new Date();
        const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

        const snapshot = await db.collection(CALL_LOGS_COLLECTION)
            .where('targetPhone', '==', cleanPhone)
            .where('timestamp', '>=', start.toISOString())
            .where('timestamp', '<=', end.toISOString())
            .orderBy('timestamp', 'desc')
            .get();

        const logs = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            logs.push({
                id: doc.id,
                contactName: data.contactName || 'Unknown Contact',
                phoneNumber: data.phoneNumber || cleanPhone,
                type: data.type || 'incoming',
                timestamp: data.timestamp,
                durationSec: data.durationSec || 0,
                carrier: data.carrier || resolveNetworkProvider(cleanPhone)
            });
        });

        return res.status(200).json({
            status: 'success',
            targetPhone: cleanPhone,
            count: logs.length,
            logs: logs
        });

    } catch (error) {
        console.error('Error fetching call logs:', error);
        return res.status(500).json({ 
            error: 'Failed to retrieve call logs from Firestore.',
            details: error.message 
        });
    }
});

/**
 * POST /api/call-logs
 * Logs a new call record into Firestore
 */
app.post('/api/call-logs', async (req, res) => {
    try {
        const { targetPhone, contactName, phoneNumber, type, durationSec, timestamp } = req.body;

        if (!targetPhone) {
            return res.status(400).json({ error: 'Field "targetPhone" is required.' });
        }

        const cleanTarget = targetPhone.replace(/[^0-9+]/g, '');
        const detectedCarrier = resolveNetworkProvider(cleanTarget);

        const newLogItem = {
            targetPhone: cleanTarget,
            contactName: contactName || 'Unknown Contact',
            phoneNumber: phoneNumber || cleanTarget,
            type: type || 'incoming', // 'incoming', 'outgoing', 'missed'
            durationSec: parseInt(durationSec || 0, 10),
            timestamp: timestamp || new Date().toISOString(),
            carrier: detectedCarrier,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        };

        const docRef = await db.collection(CALL_LOGS_COLLECTION).add(newLogItem);

        return res.status(201).json({
            status: 'success',
            id: docRef.id,
            log: newLogItem
        });

    } catch (error) {
        console.error('Error creating call log:', error);
        return res.status(500).json({ 
            error: 'Failed to save call log to Firestore.',
            details: error.message 
        });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.status(200).json({ status: 'ok', service: 'CallTrace API', timestamp: new Date() });
});

// Export App for Vercel Serverless
module.exports = app;