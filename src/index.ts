import path from "path";
import fs from "fs";
import * as ts from "typescript";
import arg from "arg";
import {assert, defined, definedMap, mapFilterUndefined, panic} from "@glideapps/ts-necessities";
import {getCycleNodesInGraph, getCyclesInGraph, makeGraphFromEdges} from "@glideapps/graphs";

// all paths here are fully resolved
interface ProjectConfig {
    readonly projectDir: string;
    readonly compilerOptionsJSON: any;
    readonly unresolvedProjectReferences: readonly string[];
}

interface ProjectInfo extends ProjectConfig {
    readonly configPath: string;
    readonly compilerOptions: ts.CompilerOptions;
    readonly outDir: string | undefined
    // config paths of references required by this project
    readonly projectReferences: Set<string>;
    // config paths of projects referencing this project
    readonly referencedFrom: Set<string>;
    // all root source files in this project
    readonly rootFiles: Set<string>;
}

interface Imports {
    readonly strong: Set<string>;
    readonly typesOnly: Set<string>;
    readonly lazy: Set<string>;
}

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

    const unresolvedProjectReferences: string[] = config.references?.map((r: { path: string }) => resolve(r.path)) ?? [];
    if (config.extends) {
        const rqrpath = resolve(config.extends);
        const baseConfig = readConfigFile(rqrpath);
        compilerOptionsJSON = baseConfig.compilerOptionsJSON;
        unresolvedProjectReferences.push(...baseConfig.unresolvedProjectReferences)
    }
    compilerOptionsJSON = {
        ...compilerOptionsJSON,
        ...config.compilerOptions,
    };

    return {
        projectDir,
        compilerOptionsJSON,
        unresolvedProjectReferences
    }
}

function readProjects(configPath: string): ProjectInfo {
    configPath = ts.resolveProjectReferencePath({path: path.resolve(configPath)});

    const existing = projectInfos.get(configPath);
    if (existing !== undefined) {
        return existing;
    }

    console.log("+++", configPath);

    const config = readConfigFile(configPath);
    const outDir = definedMap(config.compilerOptionsJSON.outDir, d => path.resolve(config.projectDir, d));

    const projectReferences = config.unresolvedProjectReferences.map(readProjects);

    const compilerOptions = ts.convertCompilerOptionsFromJson(config.compilerOptionsJSON, config.projectDir, configPath);
    if (compilerOptions.errors.length > 0) {
        console.error("!!!", configPath, JSON.stringify(compilerOptions.errors));
        return panic("Config error");
    }

    const info: ProjectInfo = {
        ...config,
        configPath,
        compilerOptions: compilerOptions.options,
        outDir,
        projectReferences: new Set(projectReferences.map(r => r.configPath)),
        referencedFrom: new Set(),
        rootFiles: new Set()
    }
    projectInfos.set(configPath, info);

    for (const r of projectReferences) {
        r.referencedFrom.add(configPath);
    }

    return info;
}

function isInPackage(p: string): boolean {
    const {dir} = path.parse(p);
    return dir.split(path.sep).some(d => d === "node_modules");
}

const importedFiles = new Map<string, Imports>();

function addRootFiles(files: Iterable<string>): void {
    for (const file of files) {
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

function modifyCompilerHost(original: ts.CompilerHost): ts.CompilerHost {
    return {
        ...original,
        getSourceFile(fileName: string, languageVersion: ts.ScriptTarget, onError?: (message: string) => void, shouldCreateNewSourceFile?: boolean): ts.SourceFile | undefined {
            if (isInPackage(fileName)) return undefined;
            return original.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
        },
        getSourceFileByPath: undefined
    }
}

// Parse all source files in this project and record their dependencies.
// Also record all the files from other projects that we depend on.
function buildDependenciesForProject(project: ProjectInfo): void {
    const allOutDirs = mapFilterUndefined(projectInfos.values(), i => i.outDir);

    // console.log("out dirs", JSON.stringify(allOutDirs));

    function shouldInclude(p: string) {
        return !isInPackage(p) && !allOutDirs.some(d => p.startsWith(d));
    }

    const host = modifyCompilerHost(ts.createCompilerHost(project.compilerOptions));
    const program = ts.createProgram({
        rootNames: Array.from(project.rootFiles),
        options: project.compilerOptions,
        host,
        projectReferences: Array.from(project.projectReferences).map(f => ({path: f}))
    });
    const sourceFiles = program.getSourceFiles();

    for (const sourceFile of sourceFiles) {
        assert(!importedFiles.has(sourceFile.fileName));
        if (!shouldInclude(sourceFile.fileName)) continue;

        const imports: Imports = {
            strong: new Set<string>(),
            typesOnly: new Set<string>(),
            lazy: new Set<string>()
        };

        function addImport(module: string, set: Set<string>) {
            const resolved = ts.resolveModuleName(module, sourceFile.fileName, program.getCompilerOptions(), host);
            if (resolved.resolvedModule !== undefined && shouldInclude(resolved.resolvedModule.resolvedFileName)) {
                // console.log("import", module, resolved.resolvedModule.resolvedFileName, resolved.resolvedModule.packageId?.name);
                set.add(resolved.resolvedModule.resolvedFileName);
            }
        }

        function walk(untypedNode: ts.Node) {
            if (untypedNode.kind === ts.SyntaxKind.ImportDeclaration) {
                const node = untypedNode as ts.ImportDeclaration;
                assert(node.moduleSpecifier.kind === ts.SyntaxKind.StringLiteral);
                const typeOnly = node.importClause?.isTypeOnly === true;
                addImport((node.moduleSpecifier as ts.StringLiteral).text, typeOnly ? imports.typesOnly : imports.strong);
            } else if (untypedNode.kind === ts.SyntaxKind.CallExpression) {
                const callNode = untypedNode as ts.CallExpression;
                if (callNode.expression.kind === ts.SyntaxKind.ImportKeyword && callNode.arguments.length === 1) {
                    const untypedArg = defined(callNode.arguments[0]);
                    if (untypedArg.kind === ts.SyntaxKind.StringLiteral) {
                        addImport((untypedArg as ts.StringLiteral).text, imports.lazy);
                    } else {
                        console.log("Non-literal import", sourceFile.fileName);
                    }
                }
            } else if (untypedNode.kind === ts.SyntaxKind.ExportDeclaration) {
                const node = untypedNode as ts.ExportDeclaration;
                if (node.moduleSpecifier !== undefined) {
                    assert(node.moduleSpecifier?.kind === ts.SyntaxKind.StringLiteral);
                    const typeOnly = node.isTypeOnly;
                    addImport((node.moduleSpecifier as ts.StringLiteral).text, typeOnly ? imports.typesOnly : imports.strong);
                }
            }

            untypedNode.forEachChild(walk);
        }

        sourceFile.forEachChild(walk);

        addRootFiles(imports.strong);
        addRootFiles(imports.typesOnly);
        addRootFiles(imports.lazy);

        importedFiles.set(sourceFile.fileName, imports);
    }
}

function processProjects(): void {
    const projectsDone = new Set<string>();

    for (; ;) {
        let allDone = true;

        for (const project of projectInfos.values()) {
            if (projectsDone.has(project.configPath)) continue;

            if (Array.from(project.referencedFrom).some(p => !projectsDone.has(p))) continue;

            console.log("***", project.configPath);
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
        "--output": String,
        "--detect-cycles": Boolean,

        "-p": "--project",
        "-r": "--root",
        "-o": "--output",
        "-c": "--detect-cycles"
    });

    const {["--project"]: projectPaths, ["--root"]: sourcePaths, ["--output"]: outputFileName} = args;

    if (projectPaths === undefined || sourcePaths === undefined) {
        usage();
        return process.exit(1);
    }

    assert(projectPaths.length > 0 && sourcePaths.length > 0);

    for (const p of projectPaths) {
        readProjects(p);
    }

    addRootFiles(sourcePaths.map(p => path.resolve(p)));

    processProjects();

    if (outputFileName !== undefined) {
        fs.writeFileSync(outputFileName,
            JSON.stringify(Object.fromEntries(Array.from(importedFiles.entries()).map(([n, i]) => [n, ({
                strong: Array.from(i.strong),
                typesOnly: Array.from(i.typesOnly),
                lazy: Array.from(i.lazy)
            })] as const))));
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
            console.error("Cyclic dependency:", JSON.stringify(shortestCycle));
            return process.exit(1);
        }
    }
}

void main();
