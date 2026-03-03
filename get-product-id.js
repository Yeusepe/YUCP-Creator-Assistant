/**
 * Extract Gumroad product ID from a link
 * Usage: node get-product-id.js <url>
 * Example: node get-product-id.js https://yeusepe.gumroad.com/l/jammr
 */

const https = require('https');
const http = require('http');

const url = process.argv[2];

if (!url) {
  console.error('Usage: node get-product-id.js <gumroad-url>');
  console.error('Example: node get-product-id.js https://yeusepe.gumroad.com/l/jammr');
  process.exit(1);
}

function fetch(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;

    client
      .get(url, (res) => {
        // Follow redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return fetch(res.headers.location).then(resolve).catch(reject);
        }

        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
      })
      .on('error', reject);
  });
}

async function getProductInfo(url) {
  const html = await fetch(url);

  // Extract data-page JSON from the HTML
  const match = html.match(/data-page="([^"]+)"/);
  if (!match) {
    throw new Error('Could not find data-page attribute');
  }

  // Decode HTML entities and parse JSON
  const decoded = match[1]
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));

  const data = JSON.parse(decoded);

  const product = data?.props?.product;
  if (!product) {
    throw new Error('Could not find product data');
  }

  return {
    id: product.id,
    permalink: product.permalink,
    name: product.name,
    seller: product.seller?.name,
    url: url,
  };
}

getProductInfo(url)
  .then((info) => {
    console.log(JSON.stringify(info, null, 2));
    console.log('\n---');
    console.log(`Product ID: ${info.id}`);
  })
  .catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
