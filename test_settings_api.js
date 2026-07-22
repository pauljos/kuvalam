import dotenv from 'dotenv';
import path from 'path';
import jwt from 'jsonwebtoken';

dotenv.config({ path: path.resolve('apps/api/.env') });

async function test() {
  const token = jwt.sign({
    sub: '5dc58e2b-8de9-47cc-829e-ffb3dc50e7eb',
    tenantId: '89c6f67e-b194-4581-a741-7140ace28881'
  }, process.env.JWT_SECRET, { expiresIn: '1h' });

  console.log("Fetching settings...");
  
  const startTime = Date.now();
  const response = await fetch('http://localhost:3001/api/v1/tenants/89c6f67e-b194-4581-a741-7140ace28881/settings', {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  const timeTaken = Date.now() - startTime;
  console.log(`Status: ${response.status} (Took ${timeTaken}ms)`);
  
  const data = await response.json();
  console.log("Data:", data);
}
test();
