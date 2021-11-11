# ts-helper

This is a simple TypeScript tool we use at Glide for two purposes so far:

1. It finds cyclic imports in our source files. We used to
   use [ESLint's `import/no-cycle` rule](https://github.com/import-js/eslint-plugin-import/blob/main/docs/rules/no-cycle.md)
   for this, but on our project it's both very slow and sometimes doesn't find existing cycles.
2. It outputs a dependency graph of all the TypeScript source files in our project which we can use for further
   analysis.

## Caveats

We've only implemented as much as we needed to make this work on our codebase, so there might be cases it doesn't
support, or on which it crashes on. If you run into such a case, please considering sending us a PR, or at least report
the issue with a reproduction.

## Usage

### `-p|--project TS-PROJECT`

Adds a project.  `TS-PROJECT` can be either a directory with a `tsconfig.json` file in it, or the path to a TypeScript
config file. ts-helper will add project references recursively, but you can add more than one root project if you need
to.

### `-r|--root SOURCE-FILE`

Adds a root TypeScript source file. This file must be in one of the specified projects. You can add more than one.

### `-c|--detect-cycles`

Runs cycle detection on all the source files reachable from the roots. If it detects a cycle it will print one of the
cycles it found and exit with an error status.

Note that it only considers "strong" imports for cycle detection, vs `type` imports and lazy imports.

### `-o|--output FILENAME`

Outputs a JSON file with the dependency graph.

## Example

In our main repository for Glide we have two TypeScript projects - one for the frontend and one for the backend. The
frontend one has one root source file and the backend has two - one for the actual backend and one for a CLI. Here's how
we run ts-helper to detect cycles in that codebase:

```shell
npx "@glideapps/ts-helper" \
    -p ~/Work/glide/functions \
    -r ~/Work/glide/functions/src/cli.ts \
    -r ~/Work/glide/functions/src/index.ts \
    -p ~/Work/glide/app \
    -r ~/Work/glide/app/src/index.tsx \
    -c
```
