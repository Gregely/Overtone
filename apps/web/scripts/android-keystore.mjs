// npm run android:keystore — create a release signing key locally (once).
// Writes android/keystore/overtone-release.jks and android/keystore.properties
// (both git-ignored). BACK THEM UP: without this key you cannot ship updates
// that install over the existing app.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const android = fileURLToPath(new URL('../android/', import.meta.url));
const jks = `${android}keystore/overtone-release.jks`;
const props = `${android}keystore.properties`;
if (existsSync(jks) || existsSync(props)) {
  console.error('A release keystore already exists. Refusing to overwrite it (that would break updates).');
  process.exit(1);
}
mkdirSync(`${android}keystore`, { recursive: true });
const password = randomBytes(24).toString('base64url');
execFileSync('keytool', [
  '-genkeypair', '-v',
  '-keystore', jks,
  '-storetype', 'PKCS12',
  '-alias', 'overtone',
  '-keyalg', 'RSA', '-keysize', '4096',
  '-validity', '10000',
  '-storepass', password,
  '-keypass', password,
  '-dname', 'CN=Overtone self-hosted build',
], { stdio: ['ignore', 'ignore', 'inherit'] });
writeFileSync(props, `# Release signing (git-ignored). Back up this file AND keystore/overtone-release.jks.\nstoreFile=keystore/overtone-release.jks\nstorePassword=${password}\nkeyAlias=overtone\nkeyPassword=${password}\n`, { mode: 0o600 });
console.log(`Created ${jks}\nand ${props}\n\nBack up BOTH files somewhere safe (password manager / encrypted backup).\nLosing them means users must uninstall and reinstall to get future updates.`);
