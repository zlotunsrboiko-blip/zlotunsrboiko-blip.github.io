import crypto from 'node:crypto';
import fs from 'node:fs';
const root=new URL('../',import.meta.url),dir=new URL('private/',root);
fs.mkdirSync(dir,{recursive:true});
const secrets={
  dataEncryptionKey:crypto.randomBytes(32).toString('base64'),
  sheetsSyncSecret:crypto.randomBytes(32).toString('base64url')
};
fs.writeFileSync(new URL('setup-secrets.json',dir),JSON.stringify(secrets));
const source=fs.readFileSync(new URL('google-apps-script/Code.gs',root),'utf8');
fs.writeFileSync(new URL('Code.deploy.gs',dir),source.replace('__SET_DURING_DEPLOYMENT__',secrets.sheetsSyncSecret));
console.log('Setup secrets generated in ignored private directory.');
