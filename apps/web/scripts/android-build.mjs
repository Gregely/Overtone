// npm run android:build  — debug APK always; signed release APK + AAB when a keystore is configured.
// Outputs are copied to apps/web/android-dist/.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const web = fileURLToPath(new URL('..', import.meta.url));
const android = `${web}android`;
const cfg = JSON.parse(readFileSync(`${web}app.config.json`, 'utf8'));
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });

if (!process.env.ANDROID_HOME && !process.env.ANDROID_SDK_ROOT && !existsSync(`${android}/local.properties`)) {
  console.error('Set ANDROID_HOME to your Android SDK (see docs/android.md).');
  process.exit(1);
}

run('npm', ['run', 'android:sync'], web);

const signed = existsSync(`${android}/keystore.properties`) || Boolean(process.env.OVERTONE_KEYSTORE_FILE);
const gradle = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
run(gradle, ['--no-daemon', 'assembleDebug', ...(signed ? ['assembleRelease', 'bundleRelease'] : [])], android);

const out = `${web}android-dist`;
mkdirSync(out, { recursive: true });
const name = `overtone-${cfg.versionName}`;
const copies = [
  [`${android}/app/build/outputs/apk/debug/app-debug.apk`, `${out}/${name}-debug.apk`],
  ...(signed
    ? [
        [`${android}/app/build/outputs/apk/release/app-release.apk`, `${out}/${name}-release.apk`],
        [`${android}/app/build/outputs/bundle/release/app-release.aab`, `${out}/${name}-release.aab`],
      ]
    : []),
];
for (const [from, to] of copies) {
  copyFileSync(from, to);
  console.log(`→ ${to.replace(web, 'apps/web/')}`);
}
if (!signed) console.log('\nNo release keystore configured: built the debug APK only. Run `npm run android:keystore` to set one up.');
