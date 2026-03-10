// Run once to generate your RSA key pair:
//   node generate-keys.js
//
// Then:
//  - Keep private.pem on the server (add to .env or keep as file, NEVER commit it)
//  - Copy the public key output into discord-config.js in the Electron app

const { generateKeyPairSync } = require('crypto')
const fs = require('fs')

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding:  { type: 'spki',  format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

fs.writeFileSync('private.pem', privateKey)
fs.writeFileSync('public.pem', publicKey)

console.log('Keys written to private.pem and public.pem\n')
console.log('Paste this public key into discord-config.js in the Electron app:\n')
console.log(publicKey)
