// Makes the download for the system it runs on, from a finished production build:
//   npm run build && npm run package
// On Windows: dist/Medicus-Vitae-<version>-windows-x64.zip (a folder with the tray app).
// On a Mac:   dist/Medicus-Vitae-<version>-mac-arm64.dmg (Medicus Vitae.app).
// .github/workflows/release.yml runs it on GitHub's Windows and Mac machines for each release.
//
// The package holds only the app: the build, the server, migrations, the browser
// extension, production dependencies installed fresh for this system, and the Node.js
// that runs this script. Nothing from data/, .env, tests/ or the development tools goes
// in, so every installation starts empty. scripts/smoke-test.mjs checks the result.
//
// Options: --build-dir <dir> (default build), --out <dir> (default dist), --no-archive.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const buildDir = path.resolve(root, option('--build-dir', 'build'));
const outDir = path.resolve(root, option('--out', 'dist'));
const makeArchive = !args.includes('--no-archive');

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const repoUrl = (typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url ?? '').replace(/^git\+/, '').replace(/\.git$/, '');
const platform = process.platform;
const arch = process.arch;
if (platform !== 'win32' && platform !== 'darwin') fail(`Packages are made on Windows or macOS (this is ${platform}). Linux and servers use the Docker image.`);
const osName = platform === 'win32' ? 'windows' : 'mac';
const baseName = `Medicus-Vitae-${version}-${osName}-${arch}`;

function fail(message) {
	console.error(message);
	process.exit(1);
}
function step(message) {
	console.log(`\n== ${message}`);
}
function run(file, argv, opts = {}) {
	const r = spawnSync(file, argv, { stdio: 'inherit', ...opts });
	if (r.error) fail(`${file}: ${r.error.message}`);
	if (r.status !== 0) fail(`${path.basename(file)} ${argv.join(' ')} failed (exit ${r.status})`);
}
function copy(from, to, filter) {
	fs.cpSync(from, to, { recursive: true, filter: filter ?? (() => true) });
}
/** Writes a text file with the line endings the target system expects and @VERSION@ / @REPO_URL@ filled in. */
function writeText(from, to, eol) {
	let text = fs.readFileSync(from, 'utf8').replace(/\r\n/g, '\n');
	text = text.replaceAll('@VERSION@', version).replaceAll('@REPO_URL@', repoUrl || 'https://github.com');
	if (eol === '\r\n') text = text.replace(/\n/g, '\r\n');
	fs.mkdirSync(path.dirname(to), { recursive: true });
	fs.writeFileSync(to, text);
}

if (!fs.existsSync(path.join(buildDir, 'handler.js'))) fail(`No build in ${buildDir}. Run: npm run build`);

step(`Packaging Medicus Vitae ${version} for ${osName} (${arch}) with Node.js ${process.version}`);
fs.rmSync(outDir, { recursive: true, force: true });
const stage = path.join(outDir, 'stage');
const bundle = path.join(stage, 'Medicus Vitae.app'); // Mac only
const appDir = platform === 'win32' ? path.join(stage, 'Medicus Vitae') : path.join(bundle, 'Contents', 'Resources', 'app');
fs.mkdirSync(appDir, { recursive: true });

step('Copying the app');
copy(buildDir, path.join(appDir, 'build'), (src) => path.basename(src) !== '.ready');
copy(path.join(root, 'server'), path.join(appDir, 'server'), (src) => fs.statSync(src).isDirectory() || src.endsWith('.js'));
copy(path.join(root, 'drizzle'), path.join(appDir, 'drizzle'));
// server/pdf-worker.js imports the page-text rules from here.
copy(path.join(root, 'src', 'lib', 'pdf'), path.join(appDir, 'src', 'lib', 'pdf'), (src) => fs.statSync(src).isDirectory() || (src.endsWith('.js') && !src.includes('.spec.')));
copy(path.join(root, 'browser-extension'), path.join(appDir, 'browser-extension'));
fs.copyFileSync(path.join(root, '.env.example'), path.join(appDir, '.env.example'));
fs.copyFileSync(path.join(root, 'package-lock.json'), path.join(appDir, 'package-lock.json'));
// The same package.json without the development scripts (npm ci checks it against the lock file).
const shipped = { ...pkg };
delete shipped.scripts;
fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify(shipped, null, '\t') + '\n');

step('Installing production dependencies for this system');
run(process.execPath, [path.join(root, 'scripts', 'install-deps.mjs'), '--omit=dev'], {
	cwd: appDir,
	env: { ...process.env, npm_config_update_notifier: 'false' }
});

// onnxruntime-node (the local search model) ships its library for every system; keep this one's.
const ortBin = path.join(appDir, 'node_modules', 'onnxruntime-node', 'bin');
if (fs.existsSync(ortBin)) {
	for (const napi of fs.readdirSync(ortBin)) {
		for (const os of fs.readdirSync(path.join(ortBin, napi))) {
			for (const cpu of fs.readdirSync(path.join(ortBin, napi, os))) {
				if (os !== platform || cpu !== arch) fs.rmSync(path.join(ortBin, napi, os, cpu), { recursive: true, force: true });
			}
			if (fs.readdirSync(path.join(ortBin, napi, os)).length === 0) fs.rmSync(path.join(ortBin, napi, os), { recursive: true });
		}
	}
}

step('Adding Node.js');
const nodeTarget = path.join(appDir, 'runtime', 'node', platform === 'win32' ? 'node.exe' : '');
if (platform === 'win32') {
	fs.mkdirSync(path.dirname(nodeTarget), { recursive: true });
	fs.copyFileSync(process.execPath, nodeTarget);
} else {
	fs.mkdirSync(path.join(appDir, 'runtime'), { recursive: true });
	fs.copyFileSync(process.execPath, path.join(appDir, 'runtime', 'node'));
	fs.chmodSync(path.join(appDir, 'runtime', 'node'), 0o755);
}
// Node's license, alongside it.
const nodeLicense = [path.join(path.dirname(process.execPath), 'LICENSE'), path.join(path.dirname(process.execPath), '..', 'LICENSE')].find((p) => fs.existsSync(p));
if (nodeLicense) fs.copyFileSync(nodeLicense, path.join(appDir, 'runtime', 'NODE-LICENSE.txt'));

if (platform === 'win32') {
	step('Building the tray app (Medicus Vitae.exe)');
	const csc = ['Framework64', 'Framework'].map((f) => path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', f, 'v4.0.30319', 'csc.exe')).find((p) => fs.existsSync(p));
	if (!csc) fail('The C# compiler that ships with Windows (.NET Framework 4) was not found.');
	const desktop = path.join(root, 'desktop');
	run(csc, [
		'/nologo',
		'/target:winexe',
		'/optimize+',
		`/out:${path.join(appDir, 'Medicus Vitae.exe')}`,
		`/win32icon:${path.join(desktop, 'medicus.ico')}`,
		'/r:System.Windows.Forms.dll',
		'/r:System.Drawing.dll',
		path.join(desktop, 'MedicusTray.cs')
	]);
	writeText(path.join(desktop, 'windows', 'Add shortcuts.cmd'), path.join(appDir, 'Add shortcuts.cmd'), '\r\n');
	writeText(path.join(desktop, 'windows', 'add-shortcuts.ps1'), path.join(appDir, 'desktop', 'add-shortcuts.ps1'), '\r\n');
	writeText(path.join(desktop, 'windows', 'README.txt'), path.join(appDir, 'README.txt'), '\r\n');
	writeText(path.join(root, 'LICENSE'), path.join(appDir, 'LICENSE.txt'), '\r\n');
	writeText(path.join(root, '.env.example'), path.join(appDir, '.env.example'), '\r\n');
} else {
	step('Making Medicus Vitae.app');
	const mac = path.join(root, 'desktop', 'mac');
	writeText(path.join(mac, 'Info.plist'), path.join(bundle, 'Contents', 'Info.plist'), '\n');
	const launcher = path.join(bundle, 'Contents', 'MacOS', 'Medicus Vitae');
	writeText(path.join(mac, 'launcher.sh'), launcher, '\n');
	fs.chmodSync(launcher, 0o755);
	fs.writeFileSync(path.join(bundle, 'Contents', 'PkgInfo'), 'APPL????');
	writeText(path.join(root, 'LICENSE'), path.join(appDir, 'LICENSE'), '\n');
	makeIcns(path.join(root, 'static', 'icons', 'icon-512.png'), path.join(bundle, 'Contents', 'Resources', 'medicus.icns'));
}

step('Checking that nothing personal went in');
const forbidden = [];
(function scan(dir, rel) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const r = rel ? `${rel}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			if (r === 'data' || r === 'tests' || r === 'build-next' || r.startsWith('build-old-')) forbidden.push(r + '/');
			scan(path.join(dir, entry.name), r);
		} else if (/^\.env$|\.(sqlite|sqlite-wal|sqlite-shm|db|apkg|colpkg|log)$/i.test(entry.name) && !r.startsWith('node_modules/')) {
			forbidden.push(r);
		}
	}
})(appDir, '');
if (forbidden.length) fail(`These should not be in a package:\n  ${forbidden.join('\n  ')}`);
console.log('OK: no data folder, .env, databases, decks or logs.');

if (!makeArchive) {
	console.log(`\nPackage folder: ${platform === 'win32' ? appDir : bundle}`);
	process.exit(0);
}

if (platform === 'win32') {
	step(`Zipping ${baseName}.zip`);
	await zipFolder(appDir, 'Medicus Vitae', path.join(outDir, `${baseName}.zip`));
} else {
	step(`Making ${baseName}.dmg`);
	writeText(path.join(root, 'desktop', 'mac', 'Read me first.txt'), path.join(stage, 'Read me first.txt'), '\n');
	fs.symlinkSync('/Applications', path.join(stage, 'Applications'));
	// hdiutil now and then fails with "Resource busy" on build machines; try a few times.
	const dmgArgs = ['create', '-volname', `Medicus Vitae ${version}`, '-srcfolder', stage, '-fs', 'HFS+', '-format', 'UDZO', '-ov', path.join(outDir, `${baseName}.dmg`)];
	for (let attempt = 1; ; attempt++) {
		const r = spawnSync('hdiutil', dmgArgs, { stdio: 'inherit' });
		if (r.status === 0) break;
		if (attempt === 4) fail('hdiutil create failed');
		console.log(`hdiutil failed, trying again (${attempt}/3)`);
		spawnSync('sleep', [String(attempt * 5)]);
	}
	fs.unlinkSync(path.join(stage, 'Applications'));
}
const archive = path.join(outDir, `${baseName}.${platform === 'win32' ? 'zip' : 'dmg'}`);
console.log(`\nDone: ${archive} (${(fs.statSync(archive).size / 1048576).toFixed(0)} MB)`);

/** The app icon in the sizes macOS wants, from the 512 px PNG (sips and iconutil come with macOS). */
function makeIcns(png, out) {
	const set = path.join(outDir, 'medicus.iconset');
	fs.mkdirSync(set, { recursive: true });
	for (const size of [16, 32, 128, 256, 512]) {
		run('sips', ['-z', String(size), String(size), png, '--out', path.join(set, `icon_${size}x${size}.png`)], { stdio: 'ignore' });
		if (size <= 256) run('sips', ['-z', String(size * 2), String(size * 2), png, '--out', path.join(set, `icon_${size}x${size}@2x.png`)], { stdio: 'ignore' });
	}
	run('iconutil', ['-c', 'icns', set, '-o', out]);
	fs.rmSync(set, { recursive: true, force: true });
}

/** Zips `dir` so it unpacks as one folder named `top`. */
async function zipFolder(dir, top, out) {
	const require = createRequire(path.join(root, 'package.json'));
	const { ZipFile } = require('yazl');
	const zip = new ZipFile();
	const done = new Promise((resolve, reject) => {
		const stream = fs.createWriteStream(out);
		stream.on('close', resolve);
		stream.on('error', reject);
		zip.outputStream.pipe(stream);
	});
	(function add(d, rel) {
		for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
			const full = path.join(d, entry.name);
			const name = `${rel}/${entry.name}`;
			if (entry.isDirectory()) add(full, name);
			else zip.addFile(full, name, { mtime: new Date(), compress: true });
		}
	})(dir, top);
	zip.end();
	await done;
}
