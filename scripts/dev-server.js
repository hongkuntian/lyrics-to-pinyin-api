// Development Server for Romanization API
// Run with: node scripts/dev-server.js

import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Import API handlers
import romanizeHandler from '../api/romanize.js';
import musicRomanizeHandler from '../api/music-romanize.js';

// Mock request/response objects for Vercel functions
function createMockReqRes(method, path, body = {}) {
    const req = {
        method,
        url: path,
        body,
        headers: { 'content-type': 'application/json' }
    };
    
    const res = {
        statusCode: 200,
        headers: {},
        body: null,
        status: function(code) {
            this.statusCode = code;
            return this;
        },
        json: function(data) {
            this.body = data;
            return this;
        },
        setHeader: function(name, value) {
            this.headers[name] = value;
        }
    };
    
    return { req, res };
}

// Routes
app.post('/api/romanize', async (req, res) => {
    const { req: mockReq, res: mockRes } = createMockReqRes('POST', '/api/romanize', req.body);
    
    try {
        await romanizeHandler(mockReq, mockRes);
        res.status(mockRes.statusCode).json(mockRes.body);
    } catch (error) {
        console.error('Romanize API error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/music-romanize', async (req, res) => {
    const { req: mockReq, res: mockRes } = createMockReqRes('POST', '/api/music-romanize', req.body);
    
    try {
        await musicRomanizeHandler(mockReq, mockRes);
        res.status(mockRes.statusCode).json(mockRes.body);
    } catch (error) {
        console.error('Music Romanize API error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        version: '2.0.0',
        endpoints: ['/api/romanize', '/api/music-romanize']
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Development server running on http://localhost:${PORT}`);
    console.log(`📚 API Documentation: http://localhost:${PORT}/health`);
    console.log(`🧪 Run tests with: node tests/api-tests.js`);
});
