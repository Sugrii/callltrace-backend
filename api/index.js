const express = require('express');
const admin = require('firebase-admin');
const https = require('https');

const app = express();

// Enable CORS Preflight and headers
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

app.use(express.json());

// In-Memory Storage Fallback (prevents database errors if Firebase credentials are missing)
let localCallLogsStore = [];

// Try initializing Firebase Admin
let db = null;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
        const rawKey = process.env.FIREBASE_SERVICE_ACCOUNT.trim();
        const parsedServiceAccount = rawKey.startsWith('{')
            ? JSON.parse(rawKey)
            : JSON.parse(Buffer.from(rawKey, 'base64').toString('utf8'));

        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert(parsedServiceAccount)
            });
        }
        db = admin.firestore();
        console.log('Firebase initialized successfully.');
    } catch (err) {
        console.warn('Firebase init warning:', err.message);
    }
} else {
    try {
        const serviceAccount = require('../serviceAccountKey.json');
        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
        }
        db = admin.firestore();
        console.log('Firebase initialized using serviceAccountKey.json.');
    } catch (err) {
        console.warn('No Firebase credentials found. Running in resilient local-storage mode.');
    }
}

const CALL_LOGS_COLLECTION = 'call_logs';

/**
 * Clean phone numbers into standard format (e.g. 0247946116)
 */
function normalizePhoneNumber(phone) {
    if (!phone) return '';
    let clean = phone.replace(/[^0-9]/g, '');
    if (clean.startsWith('233')) {
        clean = '0' + clean.substring(3);
    }
    return clean;
}

/**
 * Resolve Ghana Network Carrier Prefix
 */
function getPaystackBankCode(cleanPhone) {
    const prefix = cleanPhone.substring(0, 3);

    if (['024', '054', '055', '059', '025', '053'].includes(prefix)) {
        return { bankCode: 'MTL', carrier: 'MTN Ghana', accountNumber: cleanPhone };
    }
    if (['020', '050'].includes(prefix)) {
        return { bankCode: 'VOD', carrier: 'Telecel Ghana', accountNumber: cleanPhone };
    }
    if (['027', '057', '026', '056'].includes(prefix)) {
        return { bankCode: 'ATL', carrier: 'AT Ghana', accountNumber: cleanPhone };
    }
    if (['023'].includes(prefix)) {
        return { bankCode: 'GLO', carrier: 'Glo Ghana', accountNumber: cleanPhone };
    }

    return { bankCode: 'MTL', carrier: 'Mobile Network', accountNumber: cleanPhone };
}

/**
 * Verify account name via Paystack API
 */
function verifyNumberWithPaystack(accountNumber, bankCode) {
    return new Promise((resolve) => {
        const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY;
        
        if (!paystackSecretKey) {
            return resolve(null);
        }

        const options = {
            hostname: 'api.paystack.co',
            port: 443,
            path: `/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`,
            method: 'GET',
            headers: {
                Authorization: `Bearer ${paystackSecretKey}`,
                'Content-Type': 'application/json'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.status && parsed.data && parsed.data.account_name) {
                        resolve(parsed.data.account_name);
                    } else {
                        resolve(null);
                    }
                } catch (e) {
                    resolve(null);
                }
            });
        });

        req.on('error', () => resolve(null));
        req.setTimeout(4000, () => {
            req.destroy();
            resolve(null);
        });
        req.end();
    });
}

/**
 * GET Handler: Fetch call logs for the target phone number
 */
async function handleGetCallLogs(req, res) {
    const inputPhone = req.query.phoneNumber || req.query.targetPhone;
    if (!inputPhone) {
        return res.status(400).json({ status: 'error', message: 'Query parameter "phoneNumber" is required.' });
    }

    const cleanTarget = normalizePhoneNumber(inputPhone);
    const daysLimit = parseInt(req.query.days || '90', 10);
    const cutoffDate = new Date(Date.now() - daysLimit * 24 * 60 * 60 * 1000).toISOString();

    let logs = [];

    // Query Firestore if available
    if (db) {
        try {
            const snapshot = await db.collection(CALL_LOGS_COLLECTION)
                .where('targetPhone', '==', cleanTarget)
                .get();

            snapshot.forEach(doc => {
                const data = doc.data();
                const logTimestamp = data.timestamp || new Date().toISOString();

                if (logTimestamp >= cutoffDate) {
                    logs.push({
                        id: doc.id,
                        contactName: data.contactName || ('Subscriber (' + cleanTarget + ')'),
                        phoneNumber: data.phoneNumber || cleanTarget,
                        type: data.type || 'incoming',
                        timestamp: logTimestamp,
                        durationSec: data.durationSec || 0,
                        carrier: data.carrier || 'Mobile Network',
                        paystackVerified: Boolean(data.paystackVerified)
                    });
                }
            });
        } catch (err) {
            console.error('Firestore Query failed, reading local memory store:', err.message);
        }
    }

    // Fallback/Merge with local store records
    localCallLogsStore.forEach(item => {
        if (item.targetPhone === cleanTarget && item.timestamp >= cutoffDate) {
            // Prevent duplicates if both exist
            if (!logs.some(l => l.id === item.id)) {
                logs.push(item);
            }
        }
    });

    // Sort logs newest first
    logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    return res.status(200).json({
        status: 'success',
        targetPhone: cleanTarget,
        days: daysLimit,
        count: logs.length,
        logs: logs,
        storageEngine: db ? 'Firebase Cloud Firestore' : 'Live Local Memory Engine'
    });
}

/**
 * POST Handler: Record call event for target phone number
 */
async function handlePostCallLog(req, res) {
    const { targetPhone, contactName, phoneNumber, type, durationSec, timestamp } = req.body;

    if (!targetPhone) {
        return res.status(400).json({ status: 'error', message: 'Field "targetPhone" is required.' });
    }

    const cleanTarget = normalizePhoneNumber(targetPhone);
    const cleanCallerPhone = normalizePhoneNumber(phoneNumber || targetPhone);
    const { bankCode, carrier, accountNumber } = getPaystackBankCode(cleanTarget);

    let verifiedName = await verifyNumberWithPaystack(accountNumber, bankCode);
    const finalContactName = verifiedName || contactName || ('Subscriber (' + cleanTarget + ')');

    const newLogItem = {
        id: 'log_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
        targetPhone: cleanTarget,
        contactName: finalContactName,
        phoneNumber: cleanCallerPhone,
        type: type || 'incoming',
        durationSec: parseInt(durationSec || 0, 10),
        timestamp: timestamp || new Date().toISOString(),
        carrier: carrier,
        paystackVerified: Boolean(verifiedName)
    };

    // Save to Firestore if available
    if (db) {
        try {
            const docRef = await db.collection(CALL_LOGS_COLLECTION).add({
                ...newLogItem,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
            newLogItem.id = docRef.id;
        } catch (err) {
            console.error('Firestore Save error, falling back to local store:', err.message);
        }
    }

    // Always push to local store as backup
    localCallLogsStore.push(newLogItem);

    return res.status(201).json({
        status: 'success',
        id: newLogItem.id,
        log: newLogItem
    });
}

// Router Rule
app.all('*', (req, res) => {
    const urlPath = req.path.toLowerCase();
    const method = req.method.toUpperCase();

    if (urlPath.includes('/health')) {
        return res.status(200).json({
            status: 'ok',
            storageEngine: db ? 'Firebase Firestore' : 'Local Memory Engine',
            paystackKeyConfigured: Boolean(process.env.PAYSTACK_SECRET_KEY),
            timestamp: new Date().toISOString()
        });
    }

    if (urlPath.endsWith('/call-logs') || urlPath.includes('/call-logs')) {
        if (method === 'GET') return handleGetCallLogs(req, res);
        if (method === 'POST') return handlePostCallLog(req, res);
    }

    return res.status(404).json({
        status: 'error',
        message: `Route ${req.method} ${req.path} not found.`
    });
});

module.exports = app;
