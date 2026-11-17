/** Manifest-backed verification recipes. Discovery never executes or installs tools. */
import path from 'node:path';
import { rootPath, listProjectFiles, projectPath, textFile, packageInfo } from './workspace.js';
export interface CheckRecipe {
    name: string;
    category: string;
    ecosystem: string;
    manifest: string;
    command?: string;
    program?: string;
    args?: string[];
    requiresInstalledTool?: string;
    note?: string;
}
export async function checkCatalog(raw: string, knownPackage?: Awaited<ReturnType<typeof packageInfo>>) {
    const root = await rootPath(raw), pkg = knownPackage ?? await packageInfo(root), listed = await listProjectFiles(root, 8000), recipes: CheckRecipe[] = [];
    const runner = pkg.packageManager === 'pnpm' ? 'pnpm --config.verify-deps-before-run=false --config.manage-package-manager-versions=false' : pkg.packageManager;
    for (const [name, command] of Object.entries(pkg.scripts))
        if (/^[A-Za-z0-9_.:-]+$/.test(name) && !/(?:^|:)(?:watch|dev|serve)(?:$|:)/i.test(name))
            recipes.push({ name, category: /^test/.test(name) ? 'test' : /^build/.test(name) ? 'build' : 'check', ecosystem: 'node', manifest: 'package.json', command: `${runner} run "${name}"`, requiresInstalledTool: pkg.packageManager, note: `Declared package script: ${command}` });
    const manifests = listed.files.filter(f => f.split('/').length <= 4 && /(?:^|\/)(?:Cargo\.toml|go\.mod|pyproject\.toml|pytest\.ini|setup\.cfg|pom\.xml|build\.gradle(?:\.kts)?|CMakeLists\.txt|Gemfile|composer\.json|Package\.swift|pubspec\.yaml)$|\.(?:slnx?|[cfv]sproj|vbproj)$/i.test(f)).slice(0, 100);
    const add = (name: string, category: string, ecosystem: string, manifest: string, program: string, args: string[], note?: string) => recipes.push({ name, category, ecosystem, manifest, program, args, requiresInstalledTool: program, note });
    const dotnet = manifests.filter(f => /\.(?:slnx?|csproj|fsproj|vbproj)$/i.test(f)), solutions = dotnet.filter(f => !f.includes('/') && /\.slnx?$/i.test(f));
    const targets = solutions.length ? solutions : dotnet;
    targets.slice(0, 10).forEach((f, i) => { const suffix = targets.length === 1 ? '' : ':' + i; add('dotnet:build' + suffix, 'build', 'dotnet', f, 'dotnet', ['build', f, '--no-restore', '--nologo'], 'Requires restored dependencies; does not invoke restore.'); add('dotnet:test' + suffix, 'test', 'dotnet', f, 'dotnet', ['test', f, '--no-restore', '--nologo'], 'Requires a test project/solution and installed SDK. A zero exit code does not prove tests were discovered.'); });
    const rootFiles = new Set(listed.files.filter(f => !f.includes('/')));
    if (rootFiles.has('Cargo.toml')) {
        add('cargo:check', 'check', 'rust', 'Cargo.toml', 'cargo', ['check', '--offline']);
        add('cargo:test', 'test', 'rust', 'Cargo.toml', 'cargo', ['test', '--offline']);
        add('cargo:fmt', 'check', 'rust', 'Cargo.toml', 'cargo', ['fmt', '--all', '--', '--check']);
    }
    if (rootFiles.has('go.mod')) {
        add('go:test', 'test', 'go', 'go.mod', 'go', ['test', './...']);
        add('go:vet', 'check', 'go', 'go.mod', 'go', ['vet', './...']);
    }
    const pythonManifest = ['pyproject.toml', 'pytest.ini', 'setup.cfg'].find(f => rootFiles.has(f));
    const tests = listed.files.filter(f => /(?:^|\/)(?:__tests__|tests?|e2e)\/|\.(?:test|spec)\.[^/]+$|(?:^|\/)test_[^/]+\.py$|_test\.go$|(?:Tests?|Spec)\.(?:cs|fs|vb|java|kt|rb)$/i.test(f));
    if (pythonManifest) {
        let text = '';
        try {
            text = (await textFile(await projectPath(root, pythonManifest), 128 * 1024)).text;
        }
        catch { }
        const python = process.platform === 'win32' ? 'python' : 'python3';
        if (/pytest/i.test(text) || tests.some(f => /conftest\.py$/.test(f)) || rootFiles.has('pytest.ini'))
            add('python:test', 'test', 'python', pythonManifest, python, ['-m', 'pytest', '-q'], 'Requires pytest already installed; no pip install.');
        else if (tests.some(f => /\.py$/.test(f)))
            add('python:test', 'test', 'python', pythonManifest, python, ['-m', 'unittest', 'discover', '-s', listed.files.some(f => f.startsWith('tests/')) ? 'tests' : '.'], 'Requires review of unittest discovery; zero tests is not meaningful coverage.');
    }
    if (rootFiles.has('pom.xml')) {
        if (process.platform === 'win32')
            recipes.push({ name: 'maven:test', category: 'test', ecosystem: 'java', manifest: 'pom.xml', command: 'mvn.cmd -o test', requiresInstalledTool: 'mvn.cmd', note: 'Offline Maven; project plugins still execute.' });
        else
            add('maven:test', 'test', 'java', 'pom.xml', 'mvn', ['-o', 'test']);
    }
    if (rootFiles.has('build.gradle') || rootFiles.has('build.gradle.kts')) {
        const manifest = rootFiles.has('build.gradle.kts') ? 'build.gradle.kts' : 'build.gradle';
        if (process.platform === 'win32')
            recipes.push({ name: 'gradle:test', category: 'test', ecosystem: 'jvm', manifest, command: 'gradle.bat --offline --no-daemon test', requiresInstalledTool: 'gradle.bat' });
        else
            add('gradle:test', 'test', 'jvm', manifest, 'gradle', ['--offline', '--no-daemon', 'test']);
    }
    if (rootFiles.has('CMakeLists.txt'))
        add('cmake:build', 'build', 'c-cpp', 'CMakeLists.txt', 'cmake', ['--build', 'build'], 'Requires an already configured build directory.');
    if (rootFiles.has('Package.swift'))
        add('swift:test', 'test', 'swift', 'Package.swift', 'swift', ['test', '--disable-automatic-resolution'], 'Requires resolved dependencies and Swift installed.');
    if (rootFiles.has('pubspec.yaml')) {
        let flutter = false;
        try {
            flutter = /\bflutter\s*:/.test((await textFile(await projectPath(root, 'pubspec.yaml'), 128 * 1024)).text);
        }
        catch { }
        const name = flutter ? 'flutter' : 'dart';
        if (process.platform === 'win32')
            recipes.push({ name: name + ':test', category: 'test', ecosystem: name, manifest: 'pubspec.yaml', command: name + '.bat test' + (flutter ? ' --no-pub' : ''), requiresInstalledTool: name + '.bat', note: 'Dependencies must already be available.' });
        else
            add(name + ':test', 'test', name, 'pubspec.yaml', name, ['test', ...(flutter ? ['--no-pub'] : [])], 'Dependencies must already be available.');
    }
    const rootDefaults = ['typecheck', 'lint', 'test', 'build', 'dotnet:build', 'dotnet:test', 'cargo:check', 'cargo:test', 'go:test', 'python:test', 'maven:test', 'gradle:test', 'cmake:build', 'swift:test', 'flutter:test', 'dart:test'].filter(n => recipes.some(r => r.name === n));
    const preferred = pkg.preferences.preferences.verificationScripts;
    return { root, documentation: listed.files.filter(f => /^(README(?:\.[^/]+)?|docs\/.*\.(?:md|mdx))$/i.test(f)).slice(0, 40), packageManager: pkg.manifestHash ? pkg.packageManager : null, manifestHash: pkg.manifestHash, candidates: recipes, defaultChecks: (preferred ?? rootDefaults).slice(0, 5), manifests, ecosystems: [...new Set(recipes.map(r => r.ecosystem))], testFiles: tests.slice(0, 150), truncated: listed.truncated || tests.length > 150, execution: 'Preview only. execute=true is required. Toolchains must already be installed. Build scripts/plugins are executable project code; offline flags are not an OS network sandbox.' };
}
