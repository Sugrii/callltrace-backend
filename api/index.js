const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const https = require('https');

const app = express();

// 1. Full CORS Preflight & Request Handling
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

// 2. Initialize Firebase Admin SDK
if (!admin.apps.length) {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        try {
            const rawKey = process.env.FIREBASE_SERVICE_ACCOUNT;
            const parsedServiceAccount = rawKey.trim().startsWith('{')
                ? JSON.parse(rawKey)
                : JSON.parse(Buffer.from(rawKey, 'base64').toString('utf8'));

            admin.initializeApp({
                credential: admin.credential.cert(parsedServiceAccount)
            });
            console.log('Firebase initialized via environment variable.');
        } catch (err) {
            console.error('Error parsing FIREBASE_SERVICE_ACCOUNT:', err.message);
        }
    } else {
        try {
            const serviceAccount = require('../serviceAccountKey.json');
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            console.log('Firebase initialized via local key file.');
        } catch (err) {
            console.warn('FIREBASE_SERVICE_ACCOUNT env and serviceAccountKey.json both missing.');
        }
    }
}

const db = admin.apps.length ? admin.firestore() : null;
const CALL_LOGS_COLLECTION = 'call_logs';

/**
 * Paystack Bank/Momo Code Resolver for Ghana Telecoms
 */
function getPaystackBankCode(phone) {
    const cleanNumber = phone.replace(/[^0-9]/g, '');
    let localNumber = cleanNumber;
    
    if (cleanNumber.startsWith('233')) {
        localNumber = '0' + cleanNumber.substring(3);
    }

    const prefix = localNumber.substring(0, 3);

    // Ghana Mobile Money Bank Codes on Paystack:
    // MTN: MTL | Telecel (Vodafone): VOD | AT (AirtelTigo): ATL | Glo: GLO
    if (['024', '054', '055', '059', '025', '053'].includes(prefix)) {
        return { bankCode: 'MTL', carrier: 'MTN Ghana', accountNumber: localNumber };
    }
    if (['020', '050'].includes(prefix)) {
        return { bankCode: 'VOD', carrier: 'Telecel Ghana', accountNumber: localNumber };
    }
    if (['027', '057', '026', '056'].includes(prefix)) {
        return { bankCode: 'ATL', carrier: 'AT Ghana', accountNumber: localNumber };
    }
    if (['023'].includes(prefix)) {
        return { bankCode: 'GLO', carrier: 'Glo Ghana', accountNumber: localNumber };
    }

    return { bankCode: 'MTL', carrier: 'Standard Carrier', accountNumber: localNumber };
}

/**
 * Paystack Account Resolution API Call
 */
function verifyNumberWithPaystack(accountNumber, bankCode) {
    return new Promise((resolve) => {
        const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY;
        
        if (!paystackSecretKey) {
            console.warn('PAYSTACK_SECRET_KEY not configured. Falling back to local prefix resolver.');
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
                    if (parsed.status && parsed.data) {
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
        req.setTimeout(5000, () => {
            req.destroy();
            resolve(null);
        });
        req.end();
    });
}

/**
 * Controller: Get Call Logs
 */
const handleGetCallLogs = async (req, res) => {
    if (!db) {
        return res.status(500).json({ 
            status: 'error',
            message: 'Database connection failed. Ensure FIREBASE_SERVICE_ACCOUNT environment variable is set in Vercel.' 
        });
    }

    try {
        const { phoneNumber, startDate, endDate } = req.query;

        if (!phoneNumber) {
            return res.status(400).json({ status: 'error', message: 'Query parameter "phoneNumber" is required.' });
        }

        const cleanPhone = phoneNumber.replace(/[^0-9+]/g, '');

        // Default to past 30 days window
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
                carrier: data.carrier || 'Mobile Network'
            });
        });

        return res.status(200).json({
            status: 'success',
            targetPhone: cleanPhone,
            count: logs.length,
            logs: logs
        });

    } catch (error) {
        console.error('Error fetching logs:', error);
        return res.status(500).json({
            status: 'error',
            message: 'Firestore Query Error: ' + error.message
        });
    }
};

/**
 * Controller: Post Call Log with Paystack Account Name Verification
 */
const handlePostCallLog = async (req, res) => {
    if (!db) {
        return res.status(500).json({ 
            status: 'error',
            message: 'Database connection failed. Ensure FIREBASE_SERVICE_ACCOUNT environment variable is set in Vercel.' 
        });
    }

    try {
        const { targetPhone, contactName, phoneNumber, type, durationSec, timestamp } = req.body;

        if (!targetPhone) {
            return res.status(400).json({ status: 'error', message: 'Field "targetPhone" is required.' });
        }

        const cleanTarget = targetPhone.replace(/[^0-9+]/g, '');
        const { bankCode, carrier, accountNumber } = getPaystackBankCode(cleanTarget);

        // Verify contact name live with Paystack API if key is present
        let verifiedName = await verifyNumberWithPaystack(accountNumber, bankCode);
        const finalContactName = verifiedName || contactName || 'Subscriber (' + cleanTarget + ')';

        const newLogItem = {
            targetPhone: cleanTarget,
            contactName: finalContactName,
            phoneNumber: phoneNumber || cleanTarget,
            type: type || 'incoming',
            durationSec: parseInt(durationSec || 0, 10),
            timestamp: timestamp || new Date().toISOString(),
            carrier: carrier,
            paystackVerified: Boolean(verifiedName),
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        };

        const docRef = await db.collection(CALL_LOGS_COLLECTION).add(newLogItem);

        return res.status(201).json({
            status: 'success',
            id: docRef.id,
            log: newLogItem
        });

    } catch (error) {
        console.error('Error creating log:', error);
        return res.status(500).json({
            status: 'error',
            message: 'Firestore Save Error: ' + error.message
        });
    }
};

// Route Registrations for Vercel
app.get('/call-logs', handleGetCallLogs);
app.get('/api/call-logs', handleGetCallLogs);

app.post('/call-logs', handlePostCallLog);
app.post('/api/call-logs', handlePostCallLog);

app.get(['/health', '/api/health'], (req, res) => {
    res.status(200).json({ 
        status: 'ok', 
        service: 'CallTrace Paystack & Firebase Backend',
        paystackKeyConfigured: Boolean(process.env.PAYSTACK_SECRET_KEY),
        firebaseConfigured: Boolean(db),
        timestamp: new Date().toISOString()
    });
});

module.exports = app;
