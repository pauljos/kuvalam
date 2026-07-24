const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Store reports in memory for simplicity
let reports = [];

// API Endpoint for agents to post reports to
app.post('/api/reports', (req, res) => {
  const report = req.body;
  if (!report) {
    return res.status(400).json({ error: 'No report data provided' });
  }
  
  const newReport = {
    id: Date.now().toString(),
    timestamp: new Date().toISOString(),
    data: report
  };
  
  reports.unshift(newReport); // Add to top
  // Keep only the latest 50 reports
  if (reports.length > 50) reports.pop();
  
  console.log('Received new report:', JSON.stringify(newReport).substring(0, 100) + '...');
  res.status(201).json({ success: true, id: newReport.id });
});

// API Endpoint for the frontend to fetch reports
app.get('/api/reports', (req, res) => {
  res.json(reports);
});

// Clear reports
app.post('/api/reports/clear', (req, res) => {
  reports = [];
  res.json({ success: true });
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`Standalone Dashboard Server running on http://localhost:${PORT}`);
});
