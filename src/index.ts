#! /usr/bin/env node

import path from "path";
import fs from "fs";
import * as ts from "typescript";
import arg from "arg";
import * as glob from "glob";
import { assert, defined, definedMap, mapFilterUndefined } from "@glideapps/ts-necessities";
import { getCycleNodesInGraph, getCyclesInGraph, makeGraphFromEdges } from "@glideapps/graphs";

// All paths in these interfaces are fully resolved.

interface ProjectConfig {
    // root directory of the project (the directory where the config file lives)
    readonly projectDir: string;
    readonly compilerOptionsJSON: any;
    // these are whatever the config says, i.e. either the root directories, or
    // the config file paths.
    readonly givenProjectReferences: readonly string[];
    // the "include" option, if given
    readonly include: readonly string[] | undefined;
}

interface ProjectInfo extends ProjectConfig {
    // path of the config file
    readonly configPath: string;
    readonly compilerOptions: ts.CompilerOptions;
    readonly outDir: string | undefined;
    // config paths of project references directly required by this project
    readonly projectReferences: Set<string>;
    // config paths of projects directly referencing this project
    readonly referencedFrom: Set<string>;
    // all root source files in this project
    readonly rootFiles: Set<string>;
}

interface Imports {
    // "regular" imports
    readonly strong: Set<string>;
    // `import type`
    readonly typesOnly: Set<string>;
    // `await import`
    readonly lazy: Set<string>;
}

let verbose = false;

// config path -> info
const projectInfos = new Map<string, ProjectInfo>();

// https://stackoverflow.com/questions/67956755/how-to-compile-tsconfig-json-into-a-config-object-using-typescript-api
function readConfigFile(configPath: string): ProjectConfig {
    let compilerOptionsJSON: any = {};
    const config = ts.readConfigFile(configPath, ts.sys.readFile).config;
    const projectDir = path.dirname(configPath);

    function resolve(p: string) {
        return path.resolve(projectDir, p);
    }

    const unresolvedProjectReferences: string[] =
        config.references?.map((r: { path: string }) => resolve(r.path)) ?? [];
    if (config.extends) {
        const rqrpath = resolve(config.extends);
        const baseConfig = readConfigFile(rqrpath);
        compilerOptionsJSON = baseConfig.compilerOptionsJSON;
        unresolvedProjectReferences.push(...baseConfig.givenProjectReferences);
    }
    compilerOptionsJSON = {
        ...compilerOptionsJSON,
        ...config.compilerOptions,
    };

    let include: string[] | undefined;
    const configInclude = config.include;
    if (Array.isArray(configInclude)) {
        include = configInclude.filter(x => typeof x === "string");
    }

    return {
        projectDir,
        compilerOptionsJSON,
        givenProjectReferences: unresolvedProjectReferences,
        include,
    };
}

// Reads the given project and all its direct and indirect references, if
// they've not already been read.
function readProjects(configPath: string): ProjectInfo {
    configPath = ts.resolveProjectReferencePath({
        path: path.resolve(configPath),
    });

    const existing = projectInfos.get(configPath);
    if (existing !== undefined) {
        return existing;
    }

    if (verbose) {
        console.log("Reading project", configPath);
    }

    const config = readConfigFile(configPath);
    const outDir = definedMap(config.compilerOptionsJSON.outDir, d => path.resolve(config.projectDir, d));

    // recursively read all references
    const projectReferences = config.givenProjectReferences.map(readProjects);

    const compilerOptions = ts.convertCompilerOptionsFromJson(
        config.compilerOptionsJSON,
        config.projectDir,
        configPath
    );
    if (compilerOptions.errors.length > 0) {
        console.error("Config error", configPath, JSON.stringify(compilerOptions.errors));
        return process.exit(1);
    }

    const info: ProjectInfo = {
        ...config,
        configPath,
        compilerOptions: compilerOptions.options,
        outDir,
        projectReferences: new Set(projectReferences.map(r => r.configPath)),
        referencedFrom: new Set(),
        rootFiles: new Set(),
    };
    projectInfos.set(configPath, info);

    // add the back-edges
    for (const r of projectReferences) {
        r.referencedFrom.add(configPath);
    }

    if (verbose) {
        console.log("Added project", info.projectDir);
    }

    return info;
}

const packageRegexes: RegExp[] = [];

// We ignore files that are in node packages.
function isInPackage(p: string): boolean {
    const { dir } = path.parse(p);
    if (dir.split(path.sep).some(d => d === "node_modules")) return true;
    if (packageRegexes.some(rx => rx.test(p))) return true;
    return false;
}

// This is the dependency graph.
const importedFiles = new Map<string, Imports>();

// Find the project that a source file belongs to and add it as a root file for it.
function addRootFiles(files: Iterable<string>): void {
    for (const file of files) {
        if (verbose) {
            console.log("Adding root file", file);
        }
        let found = false;
        for (const project of projectInfos.values()) {
            if (file.startsWith(project.projectDir)) {
                project.rootFiles.add(file);
                found = true;
                break;
            }
        }
        assert(found);
    }
}

// The default compiler host will load any source file that TypeScript requests.
// We're only interested in the project source files, however, and loading files
// is slow, so we refuse to load files that are in node modules.
function modifyCompilerHost(original: ts.CompilerHost): ts.CompilerHost {
    return {
        ...original,
        getSourceFile(
            fileName: string,
            languageVersion: ts.ScriptTarget,
            onError?: (message: string) => void,
            shouldCreateNewSourceFile?: boolean
        ): ts.SourceFile | undefined {
            if (isInPackage(fileName)) return undefined;
            return original.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
        },
        getSourceFileByPath: undefined,
    };
}

// Parse all source files in this project and record their dependencies.
// Also record all the files from other projects that it depends on.
function buildDependenciesForProject(project: ProjectInfo): void {
    const allOutDirs = mapFilterUndefined(projectInfos.values(), i => i.outDir);

    // TypeScript will include the output files of project references
    // as source files for a project, but we don't care about those, so
    // we ignore them.
    function shouldInclude(p: string) {
        return !isInPackage(p) && !allOutDirs.some(d => p.startsWith(d));
    }

    const host = modifyCompilerHost(ts.createCompilerHost(project.compilerOptions));
    const program = ts.createProgram({
        rootNames: Array.from(project.rootFiles),
        options: project.compilerOptions,
        host,
        projectReferences: Array.from(project.projectReferences).map(f => ({
            path: f,
        })),
    });
    const sourceFiles = program.getSourceFiles();

    for (const sourceFile of sourceFiles) {
        if (verbose) {
            console.log("Reading file", sourceFile.fileName);
        }

        assert(!importedFiles.has(sourceFile.fileName));
        if (!shouldInclude(sourceFile.fileName)) continue;

        const imports: Imports = {
            strong: new Set<string>(),
            typesOnly: new Set<string>(),
            lazy: new Set<string>(),
        };

        function addImport(module: string, set: Set<string>) {
            const resolved = ts.resolveModuleName(module, sourceFile.fileName, program.getCompilerOptions(), host);
            if (resolved.resolvedModule !== undefined && shouldInclude(resolved.resolvedModule.resolvedFileName)) {
                set.add(resolved.resolvedModule.resolvedFileName);
            }
        }

        // We need to walk the whole parse tree to find all imports.
        function walk(untypedNode: ts.Node) {
            if (untypedNode.kind === ts.SyntaxKind.ImportDeclaration) {
                // These are top-level import declarations.
                // They can be `import` or `import type`.
                const node = untypedNode as ts.ImportDeclaration;
                assert(node.moduleSpecifier.kind === ts.SyntaxKind.StringLiteral);
                const typeOnly = node.importClause?.isTypeOnly === true;
                addImport(
                    (node.moduleSpecifier as ts.StringLiteral).text,
                    typeOnly ? imports.typesOnly : imports.strong
                );
            } else if (untypedNode.kind === ts.SyntaxKind.CallExpression) {
                // This is a "call" to `import`, which produces a promise.
                //
                // TODO: This could be an import that's just used in a type declaration,
                // such as `type X = import("foo").Bar`, which I believe/hope is treated
                // as a type-only import by TS, but we treat it as a strong import.
                const callNode = untypedNode as ts.CallExpression;
                if (callNode.expression.kind === ts.SyntaxKind.ImportKeyword && callNode.arguments.length === 1) {
                    const untypedArg = defined(callNode.arguments[0]);
                    if (untypedArg.kind === ts.SyntaxKind.StringLiteral) {
                        addImport((untypedArg as ts.StringLiteral).text, imports.lazy);
                    } else {
                        console.log("Warning: Non-literal import", sourceFile.fileName);
                    }
                }
            } else if (untypedNode.kind === ts.SyntaxKind.ExportDeclaration) {
                // Exports are treated as imports, too.
                const node = untypedNode as ts.ExportDeclaration;
                if (node.moduleSpecifier !== undefined) {
                    assert(node.moduleSpecifier?.kind === ts.SyntaxKind.StringLiteral);
                    const typeOnly = node.isTypeOnly;
                    addImport(
                        (node.moduleSpecifier as ts.StringLiteral).text,
                        typeOnly ? imports.typesOnly : imports.strong
                    );
                }
            }

            untypedNode.forEachChild(walk);
        }

        sourceFile.forEachChild(walk);

        // We need to add the dependencies as "root files" to other projects, so that
        // TypeScript knows about all the source files we need.  Note that this will also
        // add the files as roots to the current project, but we're already done with
        // loading it, so there's no harm done.
        addRootFiles(imports.strong);
        addRootFiles(imports.typesOnly);
        addRootFiles(imports.lazy);

        importedFiles.set(sourceFile.fileName, imports);
    }
}

// Process the projects in topological order, i.e. make sure we process project references
// before the projects that depend on them.
//
// NOTE: There's an oddity here, which might be an issue in some cases.  We allow adding
// any number of projects, and they might have overlapping sets of source files, i.e. more
// than one project might include a specific source file.  The way `addRootFiles` works
// makes sure that each source file gets added to only one project, and since we respect
// dependencies between projects, we should be good, but I'm not totally sure.
function processProjects(): void {
    const projectsDone = new Set<string>();

    for (;;) {
        let allDone = true;

        for (const project of projectInfos.values()) {
            if (projectsDone.has(project.configPath)) continue;

            if (Array.from(project.referencedFrom).some(p => !projectsDone.has(p))) continue;

            if (verbose) {
                console.log("Processing project", project.configPath);
            }
            buildDependenciesForProject(project);

            projectsDone.add(project.configPath);
            allDone = false;
        }

        if (allDone) break;
    }
}

function usage(): void {
    console.log("Usage: ts-helper -p PROJECT-DIR-OR-FILE -r SOURCE-FILE");
}

async function main(): Promise<void> {
    const args = arg({
        "--project": [String],
        "--root": [String],
        "--package-regex": [String],
        "--output": String,
        "--detect-cycles": Boolean,
        "--verbose": Boolean,

        "-p": "--project",
        "-r": "--root",
        "-o": "--output",
        "-c": "--detect-cycles",
        "-v": "--verbose",
    });

    const {
        ["--project"]: projectPaths,
        ["--root"]: sourcePaths,
        ["--output"]: outputFileName,
        ["--package-regex"]: packageRegexStrings,
    } = args;

    if (projectPaths === undefined) {
        usage();
        return process.exit(1);
    }

    for (const rx of packageRegexStrings ?? []) {
        packageRegexes.push(new RegExp(rx));
    }

    assert(projectPaths.length > 0);

    if (args["--verbose"]) {
        verbose = true;
    }

    for (const p of projectPaths) {
        readProjects(p);
    }

    // If no explicit source files are given, we gather all the files from the
    // packages' "include" parameters.
    if (sourcePaths === undefined) {
        for (const p of projectInfos.values()) {
            for (const i of p.include ?? []) {
                const base = path.resolve(p.projectDir, i, "**");
                const pattern = path.resolve(base, "*.{ts,tsx}");
                const ignore = [path.resolve(base, "*.test.*"), path.relative(base, "*.d.ts")];
                const filenames = glob.sync(pattern, { ignore });
                addRootFiles(filenames);
            }
        }
    } else {
        assert(sourcePaths.length > 0);
        addRootFiles(sourcePaths.map(p => path.resolve(p)));
    }

    processProjects();

    if (verbose) {
        console.log(`Read ${importedFiles.size} files`);
    }

    if (outputFileName !== undefined) {
        fs.writeFileSync(
            outputFileName,
            JSON.stringify(
                Object.fromEntries(
                    Array.from(importedFiles.entries()).map(
                        ([n, i]) =>
                            [
                                n,
                                {
                                    strong: Array.from(i.strong),
                                    typesOnly: Array.from(i.typesOnly),
                                    lazy: Array.from(i.lazy),
                                },
                            ] as const
                    )
                )
            )
        );
    }

    if (args["--detect-cycles"]) {
        const adjacency = new Map(Array.from(importedFiles).map(([n, i]) => [n, i.strong] as const));
        const graph = makeGraphFromEdges(adjacency);
        const cycleNodes = getCycleNodesInGraph(graph);
        if (cycleNodes !== undefined) {
            const cycles = getCyclesInGraph(graph, cycleNodes);
            assert(cycles.length > 0);
            const shortestLength = Math.min(...cycles.map(c => c.length));
            const shortestCycle = defined(cycles.find(c => c.length === shortestLength));
            console.error(`Found ${cycles.length} dependency cycles`);
            console.error(JSON.stringify(shortestCycle));
            return process.exit(1);
        }
    }
}

void main();
