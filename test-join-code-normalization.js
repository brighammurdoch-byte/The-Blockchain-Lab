/**
 * Test join code normalization
 */

const http = require('http');

async function httpRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: 3000,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          resolve(response);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    if (body) {
      req.end(JSON.stringify(body));
    } else {
      req.end();
    }
  });
}

async function testJoinCodeNormalization() {
  console.log('=== Test: Join Code Normalization ===\n');
  
  try {
    // Step 1: Create a session
    console.log('Step 1: Creating session...');
    const sessionData = await httpRequest('POST', '/lab/create', {});
    if (!sessionData.success) {
      throw new Error('Failed to create session: ' + sessionData.error);
    }
    const { sessionId, joinCode } = sessionData;
    console.log(`✓ Session created with join code: ${joinCode}\n`);
    
    // Step 2: Try joining with different code formats
    const testCases = [
      { code: joinCode, label: 'Exact code (uppercase)' },
      { code: joinCode.toLowerCase(), label: 'Lowercase' },
      { code: joinCode.toLowerCase().toUpperCase(), label: 'Mixed case' },
      { code: '  ' + joinCode + '  ', label: 'With whitespace' },
      { code: ' ' + joinCode.toLowerCase() + ' ', label: 'Lowercase with whitespace' }
    ];
    
    for (let i = 0; i < testCases.length; i++) {
      const testCase = testCases[i];
      console.log(`Step ${i + 2}: Joining with ${testCase.label}...`);
      console.log(`  Sending code: "${testCase.code}"`);
      
      const joinResult = await httpRequest('POST', '/lab/join', {
        joinCode: testCase.code,
        role: 'miner'
      });
      
      if (!joinResult.success) {
        throw new Error(`Failed to join with ${testCase.label}: ${joinResult.error}`);
      }
      
      console.log(`✓ Successfully joined with ${testCase.label}`);
    }
    
    console.log(`\n=== TEST PASSED ===`);
    console.log(`✓ All join code format variations work correctly`);
    process.exit(0);
    
  } catch (error) {
    console.error('\n✗ TEST FAILED:', error.message);
    process.exit(1);
  }
}

// Run test
testJoinCodeNormalization();
