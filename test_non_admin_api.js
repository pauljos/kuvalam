import dotenv from 'dotenv';
import path from 'path';
import jwt from 'jsonwebtoken';

// Load env from apps/api/.env
dotenv.config({ path: path.resolve('apps/api/.env') });

async function testNonAdminAPI() {
  const JWT_SECRET = process.env.JWT_SECRET || 'kuvalam-dev-secret-min-32-chars-change-in-prod';
  
  const token = jwt.sign({
    sub: '5dc58e2b-8de9-47cc-829e-ffb3dc50e7eb', // paul@test.com
    email: 'paul@test.com',
    tenantId: '89c6f67e-b194-4581-a741-7140ace28881',
    isSystemAdmin: false,
    role: 'OWNER'
  }, JWT_SECRET, { expiresIn: '1h' });

  console.log("Generated JWT for paul@test.com");

  const response = await fetch('http://localhost:3001/api/v1/tenants/89c6f67e-b194-4581-a741-7140ace28881/custom-models', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      modelName: "non-admin-test-model",
      baseModelPath: "unsloth/Llama-3.2-1B-Instruct",
      dataSource: "web",
      webUrl: "https://example.com/non-admin-test"
    })
  });

  const data = await response.json();
  console.log("API Response:", data);
}

testNonAdminAPI();
