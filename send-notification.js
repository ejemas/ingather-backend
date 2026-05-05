/**
 * ──────────────────────────────────────────────────────────────
 *  INGATHER — Send Broadcast Notification
 * ──────────────────────────────────────────────────────────────
 *
 *  Usage:
 *    node send-notification.js "Your notification message here"
 *
 *  Examples:
 *    node send-notification.js "We just launched a new feature! Check it out."
 *    node send-notification.js "Scheduled maintenance tonight at 11 PM."
 *
 *  For production (Render):
 *    Set BACKEND_URL and ADMIN_API_KEY environment variables.
 * ──────────────────────────────────────────────────────────────
 */

require('dotenv').config();

const http = require('http');
const https = require('https');

// Config — uses .env values or defaults to local dev
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:5000';
const ADMIN_KEY = process.env.ADMIN_API_KEY;

// Get the message from the command line argument
const message = process.argv[2];

if (!message) {
  console.log('\n❌  No message provided!\n');
  console.log('Usage:  node send-notification.js "Your message here"\n');
  console.log('Example:');
  console.log('  node send-notification.js "We just released dark mode improvements!"\n');
  process.exit(1);
}

if (!ADMIN_KEY) {
  console.log('\n❌  ADMIN_API_KEY not found in .env file!\n');
  process.exit(1);
}

// Parse the backend URL
const url = new URL('/api/notifications/broadcast', BACKEND_URL);
const isHttps = url.protocol === 'https:';
const client = isHttps ? https : http;

const data = JSON.stringify({
  title: 'Ingather',
  message: message
});

const req = client.request({
  hostname: url.hostname,
  port: url.port || (isHttps ? 443 : 80),
  path: url.pathname,
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Admin-Key': ADMIN_KEY,
    'Content-Length': Buffer.byteLength(data)
  }
}, res => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    if (res.statusCode === 201) {
      const result = JSON.parse(body);
      console.log('\n✅  Notification sent successfully!\n');
      console.log(`   Title:   ${result.notification.title}`);
      console.log(`   Message: ${result.notification.message}`);
      console.log(`   ID:      ${result.notification.id}`);
      console.log(`   Time:    ${new Date(result.notification.createdAt).toLocaleString()}\n`);
      console.log('All registered churches will see this in their Settings → Notifications tab.\n');
    } else {
      console.log(`\n❌  Error (${res.statusCode}): ${body}\n`);
    }
  });
});

req.on('error', err => {
  console.log(`\n❌  Connection error: ${err.message}`);
  console.log('Make sure your backend server is running.\n');
});

req.write(data);
req.end();
