// npm runs `prepare` whenever mesh-serve is installed from git -- including as a *devDependency of
// a dependency* (surfdns-intel, -domains, -certs... all list mesh-serve), where nothing ever uses
// its compiled output. There, @flybyme/mesh has no dist/: mesh builds itself in `postinstall`, and
// the platform's builder installs with --ignore-scripts, which the nested install inherits. The
// build then failed ("Cannot find module .../@flybyme/mesh/dist/index.js") and took every part's
// build down with it (2026-09-27). So: build when mesh is built, otherwise say why and skip.
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const meshDist = new URL('../node_modules/@flybyme/mesh/dist/index.js', import.meta.url);
if (!existsSync(meshDist)) {
    console.log('mesh-serve prepare: @flybyme/mesh has no dist/ here (installed with scripts off) -- skipping the build');
    process.exit(0);
}
execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });
