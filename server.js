const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.FRONTEND_URL,
    methods: ['GET', 'POST', 'PUT', 'DELETE']
  }
});

// Middleware
// app.use(cors());
// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Make io accessible to routes
app.set('io', io);

// Import routes
const authRoutes = require('./routes/authRoutes');
const programRoutes = require('./routes/programRoutes');
const scanRoutes = require('./routes/scanRoutes');

// API Routes
app.get('/', (req, res) => {
  res.json({ message: 'Ingather API is running!' });
});

app.use('/api/auth', authRoutes);
app.use('/api/programs', programRoutes);
app.use('/api/scan', scanRoutes);

// Socket.io connection
io.on('connection', (socket) => {
  console.log('✅ New client connected:', socket.id);
  
  // Join program room for real-time updates
  socket.on('join-program', (programId) => {
    socket.join(`program-${programId}`);
    console.log(`Client ${socket.id} joined program ${programId}`);
  });
  
  socket.on('disconnect', () => {
    console.log('❌ Client disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`
🚀 Server is running on port ${PORT}
🌐 Frontend URL: ${process.env.FRONTEND_URL}
📊 Database: ${process.env.DB_NAME}
  `);
});