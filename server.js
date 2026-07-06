'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PRINTER_PORT = 9100; // Zebra raw ZPL port (RAW / JetDirect)
const PUBLIC_DIR = path.join(__dirname, 'public');

/**
 * Send a raw ZPL string to a Zebra printer over TCP port 9100.
 * Resolves when the data has been flushed and the socket closed.
 */
function sendToPrinter(ip, zpl, { port = PRINTER_PORT, timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;

    const done = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      err ? reject(err) : resolve();
    };

    socket.setTimeout(timeout);
    socket.once('timeout', () =>
      done(new Error(`Connection to ${ip}:${port} timed out after ${timeout}ms`))
    );
    socket.once('error', (err) => done(err));

    socket.connect(port, ip, () => {
      socket.write(zpl, 'utf8', () => {
        // Give the printer a moment to read the buffer, then close.
        socket.end();
      });
    });

    socket.once('close', () => done());
  });
}

/** A simple, self-contained ZPL test label for a 203dpi GX420d. */
function testLabelZpl() {
  return [
    '^XA',
    '^CF0,40',
    '^FO40,40^FDZebra GX420d^FS',
    '^CF0,28',
    '^FO40,100^FDPrint test successful^FS',
    '^FO40,150^GB700,3,3^FS',
    '^FO40,175^FDConnection OK via port 9100^FS',
    '^FO40,215^FDZPL over raw TCP^FS',
    '^XZ',
  ].join('\n');
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
  // Prevent path traversal outside PUBLIC_DIR.
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const type = STATIC_TYPES[path.extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}

async function handlePrint(req, res) {
  let payload;
  try {
    payload = JSON.parse((await readBody(req)) || '{}');
  } catch {
    return sendJson(res, 400, { ok: false, error: 'Invalid JSON body' });
  }

  const ip = (payload.ip || '').trim();
  if (!ip) return sendJson(res, 400, { ok: false, error: 'Printer IP is required' });

  const port = Number(payload.port) || PRINTER_PORT;
  const zpl =
    typeof payload.zpl === 'string' && payload.zpl.trim()
      ? payload.zpl
      : testLabelZpl();

  try {
    await sendToPrinter(ip, zpl, { port });
    sendJson(res, 200, { ok: true, message: `Sent ${Buffer.byteLength(zpl)} bytes to ${ip}:${port}` });
  } catch (err) {
    sendJson(res, 502, { ok: false, error: err.message });
  }
}

function createPrintServer() {
  return http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/print') {
      handlePrint(req, res).catch((err) =>
        sendJson(res, 500, { ok: false, error: err.message })
      );
      return;
    }
    if (req.method === 'GET' && req.url === '/api/test-zpl') {
      return sendJson(res, 200, { ok: true, zpl: testLabelZpl() });
    }
    if (req.method === 'GET') return serveStatic(req, res);

    res.writeHead(405);
    res.end('Method not allowed');
  });
}

/**
 * Start the label server bound to loopback only and resolve once it is
 * listening. Pass port 0 (the default) to let the OS pick a free port —
 * the caller reads the real port from server.address().port.
 *
 * Loopback-only binding means the server is reachable from this machine
 * exclusively; it is never exposed to the LAN and triggers no Windows
 * Firewall prompt.
 */
function start(port = PORT, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = createPrintServer();
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

module.exports = { start, createPrintServer, testLabelZpl, sendToPrinter };

// Allow running the server standalone with `node server.js` (dev / headless).
if (require.main === module) {
  start(PORT).then((server) => {
    const { port } = server.address();
    console.log(`Zebra label server running at http://127.0.0.1:${port}`);
  });
}
