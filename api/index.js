const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();

// 1. Configure CORS to allow access from any origin
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// 2. Initialize Firebase Admin SDK
if (!admin.apps.length) {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        try {
            // Read Base64 or standard raw JSON string from environment variable
            const rawKey = process.env.FIREBASE_SERVICE_ACCOUNT;
            const parsedServiceAccount = rawKey.trim().startsWith('{')
                ? JSON.parse(rawKey)
                : JSON.parse(Buffer.from(rawKey, 'base64').toString('utf8'));

            admin.initializeApp({
                credential: admin.credential.cert(parsedServiceAccount)
            });
            console.log('Firebase Admin initialized via FIREBASE_SERVICE_ACCOUNT env.');
        } catch (err) {
            console.error('Error parsing FIREBASE_SERVICE_ACCOUNT environment variable:', err.message);
        }
    } else {
        try {
            const serviceAccount = require('../serviceAccountKey.json');
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            console.log('Firebase Admin initialized via local serviceAccountKey.json.');
        } catch (err) {
            console.warn('Warning: FIREBASE_SERVICE_ACCOUNT env missing and local serviceAccountKey.json not found.');
        }
    }
}

const db = admin.apps.length ? admin.firestore() : null;
const CALL_LOGS_COLLECTION = 'call_logs';

/**
 * Ghana Telecom Carrier Auto-Detection Helper
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

    return cleanNumber.startsWith('+') && !cleanNumber.startsWith('+233') ? 'International Carrier' : 'Standard Mobile Carrier';
}

/**
 * Controller: Get Call Logs
 */
const handleGetCallLogs = async (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database connection failed. Check Firebase Service Account config.' });
    }

    try {
        const { phoneNumber, startDate, endDate } = req.query;

        if (!phoneNumber) {
            return res.status(400).json({ error: 'Query parameter "phoneNumber" is required.' });
        }

        const cleanPhone = phoneNumber.replace(/[^0-9+]/g, '');

        // Default: past 30 days
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
        console.error('Error in handleGetCallLogs:', error);
        return res.status(500).json({
            error: 'Failed to query call logs from Firestore.',
            details: error.message
        });
    }
};

/**
 * Controller: Save Call Log
 */
const handlePostCallLog = async (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database connection failed. Check Firebase Service Account config.' });
    }

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
            type: type || 'incoming',
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
        console.error('Error in handlePostCallLog:', error);
        return res.status(500).json({
            error: 'Failed to create log entry in Firestore.',
            details: error.message
        });
    }
};

// Map routes for both Vercel Serverless environment and direct local invocation
app.get('/call-logs', handleGetCallLogs);
app.get('/api/call-logs', handleGetCallLogs);

app.post('/call-logs', handlePostCallLog);
app.post('/api/call-logs', handlePostCallLog);

app.get(['/health', '/api/health'], (req, res) => {
    res.status(200).json({ status: 'ok', service: 'CallTrace API', timestamp: new Date().toISOString() });
});

module.exports = app;