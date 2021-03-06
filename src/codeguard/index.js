"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
const schematics_1 = require("@angular-devkit/schematics");
const tasks_1 = require("@angular-devkit/schematics/tasks");
const core_1 = require("@angular-devkit/core");
const fs_1 = require("fs");
const path_1 = require("path");
const child_process_1 = require("child_process");
const prettier_1 = require("prettier");
const lodash_1 = require("lodash");
const rxjs_1 = require("rxjs");
const jsonpath_1 = tslib_1.__importDefault(require("jsonpath"));
const astUtils = require('esprima-ast-utils');
let prettierConfig;
function readFileAsJSON(path) {
    return JSON.parse(fs_1.readFileSync(path).toString());
}
function getBasePath(options) {
    return options.new ? `/${options.name}` : '';
}
function parseHeaders(options) {
    const ret = {};
    if (!options.a11y) {
        return JSON.stringify(ret);
    }
    options.headers.forEach((header) => {
        const arr = header.split(':');
        ret[arr[0]] = arr[1];
    });
    return JSON.stringify(ret);
}
function checkArgs(options, _context) {
    try {
        if (fs_1.existsSync(options.docDir)) {
            throw new schematics_1.SchematicsException(`The "${options.docDir}" docs directory already exists!`);
        }
        else if (isNaN(parseInt(options.port, 10))) {
            throw new schematics_1.SchematicsException(`The "${options.port}" port number is not an integer!`);
        }
        else if (options.cypressPort && isNaN(parseInt(options.cypressPort, 10))) {
            throw new schematics_1.SchematicsException(`The "${options.cypressPort}" Cypress port number is not an integer!`);
        }
        else if (options.customWebpack && !fs_1.existsSync(options.customWebpack)) {
            throw new schematics_1.SchematicsException(`The "${options.customWebpack}" webpack config file doesn't exist!`);
        }
    }
    catch (e) {
        _context.logger.fatal(`ERROR: ${e.message}`);
        process.exit();
    }
}
function getStyle(workspace, options) {
    let schematics = jsonpath_1.default.query(workspace.projects[options.name], '$..schematics');
    let result = null;
    if (!schematics.length) {
        schematics = jsonpath_1.default.query(workspace, '$..schematics');
    }
    for (const schematic of schematics) {
        const data = Object.keys(schematic);
        for (const key of data) {
            const styleKey = schematic[key].style ? 'style' : 'styleext';
            if (schematic[key][styleKey]) {
                result = schematic[key][styleKey] === 'css' ? { syntax: 'css', rules: 'stylelint-config-recommended' }
                    : { syntax: schematic[key][styleKey], rules: 'stylelint-config-recommended-scss' };
                break;
            }
        }
    }
    if (!result) {
        result = { syntax: 'css', rules: 'stylelint-config-recommended' };
    }
    return result;
}
function isWindows() {
    return process.platform === 'win32';
}
function fileOpenCommand() {
    return isWindows() ? 'start' : 'open';
}
//@ts-ignore
function installPackages(tree, _context, options) {
    const rules = [];
    const filePath = path_1.join(__dirname, './data/packages.json');
    const packages = readFileAsJSON(filePath);
    const packageJsonPath = `${getBasePath(options)}/package.json`;
    let angularVersion = 0;
    if (options.new) {
        //@ts-ignore
        angularVersion = parseInt(child_process_1.execSync('ng --version').toString().match(/[0-9]{1}/)[0], 10);
    }
    else {
        //@ts-ignore
        angularVersion = parseInt(readFileAsJSON(`${path_1.join(process.cwd(), packageJsonPath)}`).dependencies['@angular/common'].match(/[0-9]{1}/)[0], 10);
    }
    rules.push(updateJSONFile(packageJsonPath, {
        dependencies: packages.dependencies,
        devDependencies: Object.assign({}, packages.devDependencies)
    }));
    if (options.useMd) {
        rules.push(updateJSONFile(packageJsonPath, {
            //@ts-ignore
            devDependencies: packages.markdown
        }));
    }
    if (options.useSnyk) {
        rules.push(updateJSONFile(packageJsonPath, {
            //@ts-ignore
            devDependencies: packages.snyk
        }));
    }
    if (options.cypressPort) {
        rules.push(updateJSONFile(packageJsonPath, {
            //@ts-ignore
            devDependencies: Object.assign(Object.assign({ "ngx-build-plus": angularVersion >= 8 ? '^8' : '^7' }, (packages.cypress)), (options.a11y ? packages.cypressA11y : {}))
        }));
    }
    //@ts-ignore
    const peerDepsString = child_process_1.execSync(`npm info "eslint-config-airbnb-base@latest" peerDependencies`).toString();
    const esLintAndPeerDeps = eval(`new Object(${peerDepsString.replace(/\s/g, '')})`);
    if (options.linter === 'eslint') {
        rules.push(updateJSONFile(packageJsonPath, {
            //@ts-ignore
            devDependencies: Object.assign(Object.assign({ tslint: packages.tslint.tslint }, esLintAndPeerDeps), packages.eslint)
        }));
    }
    else {
        rules.push(updateJSONFile(packageJsonPath, {
            devDependencies: packages.tslint
        }), deleteFromJSONFile(packageJsonPath, 'devDependencies', esLintAndPeerDeps));
    }
    return schematics_1.chain(rules);
}
function applyWithOverwrite(source, rules, options) {
    return (tree, _context) => {
        if (options.new) {
            rules.push(schematics_1.move('/', options.name));
        }
        const rule = schematics_1.mergeWith(schematics_1.apply(source, [
            ...rules,
            schematics_1.forEach((fileEntry) => {
                if (tree.exists(fileEntry.path)) {
                    tree.overwrite(fileEntry.path, fileEntry.content);
                    return null;
                }
                return fileEntry;
            }),
        ]), schematics_1.MergeStrategy.AllowOverwriteConflict);
        return rule(tree, _context);
    };
}
//@ts-ignore
function updateWebpackConfig(filePath) {
    return (tree, _context) => {
        const buffer = tree.read(filePath);
        let parsed = astUtils.parse(buffer.toString());
        astUtils.parentize(parsed);
        const extraCfgStr = `{
      test: /\.(js|ts)$/,
      loader: 'istanbul-instrumenter-loader',
      options: { esModules: true },
      enforce: 'post',
      include: require('path').join(__dirname, '..', 'src'),
      exclude: [
        /\.(e2e|spec)\.ts$/,
        /node_modules/,
        /(ngfactory|ngstyle)\.js/
      ]
    }
  `;
        const hasIstanbul = astUtils.filter(parsed, function (node) {
            return (node.type === 'ObjectExpression' && node.properties.find((prop) => {
                return prop.value && prop.value.value === 'istanbul-instrumenter-loader';
            }));
        });
        if (hasIstanbul !== null) {
            return tree;
        }
        const hasRules = astUtils.filter(parsed, function (node) {
            return (node.type === 'Identifier' && node.name === 'rules');
        });
        const hasModule = astUtils.filter(parsed, function (node) {
            return (node.type === 'Identifier' && node.name === 'module');
        });
        let targetNode = null;
        let tokenSkip = 0;
        let codeToInject = extraCfgStr;
        if (hasModule.length === 1) {
            targetNode = hasModule[0];
            tokenSkip = 4;
            codeToInject = 'module: { rules: [' + extraCfgStr + ']},';
        }
        else if (hasRules === null) {
            targetNode = hasModule[1];
            tokenSkip = 2;
            codeToInject = 'rules: [ ' + extraCfgStr + '],';
        }
        else {
            targetNode = hasRules[0];
            tokenSkip = 2;
            codeToInject = extraCfgStr + ',';
        }
        const tokenIndex = parsed.tokens.findIndex((token) => token.range && token.range[0] === targetNode.range[0]);
        const targetRange = parsed.tokens[tokenIndex + tokenSkip].range;
        astUtils.injectCode(parsed, [targetRange[0] + 1, targetRange[1]], codeToInject);
        tree.overwrite(filePath, prettier_1.format(astUtils.getCode(parsed), Object.assign(Object.assign({}, prettierConfig), { parser: 'babel' })));
        return tree;
    };
}
function updateGitIgnore(entries, options) {
    return (tree, _context) => {
        var _a;
        const path = `${getBasePath(options)}/.gitignore`;
        const contents = (_a = tree.read(path)) === null || _a === void 0 ? void 0 : _a.toString().split('\n');
        for (let entry of entries) {
            if (!contents.find(line => line === entry)) {
                contents.push(entry);
            }
        }
        tree.overwrite(path, contents.join('\n'));
        return tree;
    };
}
function updateJSONFile(filePath, newContent, exists = true) {
    return (tree, _context) => {
        const buffer = !exists ? new Buffer('{}') : tree.read(filePath);
        let content = JSON.parse(buffer.toString());
        content = prettier_1.format(JSON.stringify(lodash_1.merge(content, newContent)), Object.assign(Object.assign({}, prettierConfig), { parser: 'json' }));
        if (!exists) {
            tree.create(filePath, content);
        }
        else {
            tree.overwrite(filePath, content);
        }
        return tree;
    };
}
function deleteFromJSONFile(filePath, prefix, tobeRemoved) {
    return (tree, _context) => {
        const buffer = tree.read(filePath);
        let content = JSON.parse(buffer.toString());
        content = lodash_1.omit(content, Object.keys(tobeRemoved).map(prop => `${[prefix]}.${prop}`));
        tree.overwrite(filePath, prettier_1.format(JSON.stringify(content), Object.assign(Object.assign({}, prettierConfig), { parser: 'json' })));
        return tree;
    };
}
function addCompoDocScripts(options, tree) {
    let configFile = 'src/tsconfig.app.json';
    if (!tree.exists(configFile)) {
        configFile = 'tsconfig.json';
    }
    return updateJSONFile(`${getBasePath(options)}/package.json`, {
        scripts: {
            'guard:docs:build': `npx compodoc --language ${options.docLocale}`,
            'guard:docs:show': `npx compodoc -s --language ${options.docLocale}`
        }
    });
}
function addWebpackBundleAnalyzerScripts(options) {
    return updateJSONFile(`${getBasePath(options)}/package.json`, {
        scripts: {
            'guard:analyze': `npx webpack-bundle-analyzer`
        }
    });
}
function addPa11y(options) {
    return updateJSONFile(`${getBasePath(options)}/package.json`, {
        scripts: {
            'guard:a11y': `npx pa11y -c ./pa11y.json`
        }
    });
}
function addNpmAudit(options) {
    const audit = [`npx audit-ci --report-type summary --pass-enoaudit -${options.auditLevel} --config ./audit-ci.json`];
    const auditDev = [`npx audit-ci --report-type full -l`];
    const snyk = 'npx snyk test';
    if (options.useSnyk) {
        audit.push(snyk);
        auditDev.push(snyk + ' --dev');
    }
    return updateJSONFile(`${getBasePath(options)}/package.json`, {
        scripts: {
            'guard:audit': `${options.packageMgr} audit && ${auditDev[1] || '""'}`,
            'guard:audit:ci': audit.join(' && '),
            'guard:audit:dev': auditDev.join(' && ')
        }
    });
}
function addSnykMonitor(options) {
    return updateJSONFile(`${getBasePath(options)}/package.json`, {
        scripts: {
            'guard:audit:monitor': 'npx snyk monitor'
        }
    });
}
function command({ command, args }) {
    return (host, _context) => {
        return new rxjs_1.Observable(subscriber => {
            const child = child_process_1.spawn(command, args, { stdio: 'inherit' });
            child.on('error', error => {
                subscriber.error(error);
            });
            child.on('close', () => {
                subscriber.next(host);
                subscriber.complete();
            });
            return () => {
                child.kill();
            };
        });
    };
}
exports.command = command;
function addLintScripts(options, project) {
    const baseCmd = options.packageMgr === 'yarn' ? 'yarn' : 'npm run';
    let npxCommands = [['guard:eslint', 'npx eslint src/**/*.ts']];
    let npmCommands = [`${baseCmd} guard:eslint`];
    const style = getStyle(project, options);
    if (options.linter === 'tslint') {
        npxCommands = [['guard:tslint', 'npx tslint -p tsconfig.json -c tslint.json']];
        npmCommands = [`${baseCmd} guard:tslint`];
    }
    if (style.syntax !== 'styl') {
        if (style.syntax === 'css') {
            npxCommands.push(['guard:stylelint', 'npx stylelint "./src/**/*.css" --format=css']);
            npmCommands.push(`${baseCmd} guard:stylelint`);
        }
        else {
            npxCommands.push(['guard:stylelint', `npx stylelint "./src/**/*.{${style.syntax},css}"`]);
            npmCommands.push(`${baseCmd} guard:stylelint`);
        }
    }
    npxCommands.push(['guard:jsonlint', `npx jsonlint-cli "./src/**/*.{json,JSON}"`]);
    npmCommands.push(`${baseCmd} guard:jsonlint`);
    if (options.useMd) {
        const mdGlob = isWindows() ? '**/*.{md,MD}' : "'**/*.{md,MD}' ";
        npxCommands.push(['guard:markdownlint', `npx markdownlint ${mdGlob} -i 'node_modules/**' -i '**/node_modules/**' -c mdlint.json`]);
        npmCommands.push(`${baseCmd} guard:markdownlint`);
    }
    npxCommands.push(['guard:lint', npmCommands.join(' && ')]);
    let packageMock = { scripts: {} };
    npxCommands.forEach((scriptsDescription) => {
        packageMock.scripts = Object.assign({}, packageMock.scripts, { [scriptsDescription[0]]: scriptsDescription[1] });
    });
    return updateJSONFile(`${getBasePath(options)}/package.json`, packageMock);
}
function addCypressScripts(options) {
    return updateJSONFile(`${getBasePath(options)}/package.json`, {
        "scripts": {
            "guard:test:headless": `npx cypress run --port ${options.cypressPort}`,
            "guard:test:manual": `npx cypress open  --browser chrome --port ${options.cypressPort}`,
            "guard:test:all": `npx cypress run --browser chrome --port ${options.cypressPort}`,
            "guard:report:html": `npx nyc report --reporter=lcov && ${fileOpenCommand()} coverage/lcov-report/index.html`,
            "guard:report:text": "npx nyc report --reporter=text",
            "guard:report:summary": "npx nyc report --reporter=text-summary",
        },
        "nyc": {
            "extends": "@istanbuljs/nyc-config-typescript",
            "all": true,
            "reporter": [
                "text",
                "html"
            ]
        }
    });
}
function addDevBuilder(options) {
    let webpackCfg = './tests/coverage.webpack.js';
    if (!options.new) {
        webpackCfg = options.customWebpack || webpackCfg;
    }
    return updateJSONFile(`${getBasePath(options)}/angular.json`, {
        projects: {
            [options.name]: {
                architect: {
                    'serve': {
                        "builder": "ngx-build-plus:dev-server",
                        "options": {
                            "extraWebpackConfig": webpackCfg
                        },
                    }
                }
            }
        }
    });
}
function codeGuard(options) {
    return (tree, _context) => {
        var _a;
        const configPath = `${getBasePath(options)}/.codeguardrc`;
        if (options.useConfig) {
            if (tree.exists(configPath)) {
                options = readFileAsJSON('.codeguardrc');
            }
            else {
                throw new schematics_1.SchematicsException('Could not find config file ./.codeguardrc');
            }
        }
        checkArgs(options, _context);
        const workspaceConfig = tree.read(`${getBasePath(options)}/angular.json`);
        if (!workspaceConfig) {
            throw new schematics_1.SchematicsException('Could not find Angular workspace configuration');
        }
        const workspaceContent = workspaceConfig.toString();
        const workspace = JSON.parse(workspaceContent);
        if (!options.name) {
            options.name = workspace.defaultProject;
        }
        const tsConfig = readFileAsJSON(path_1.join(__dirname, 'data/tsconfig_partial.json'));
        prettierConfig = readFileAsJSON(path_1.join(__dirname, 'files/.prettierrc'));
        const packageJsonPath = `${getBasePath(options)}/package.json`;
        let packageJson = {};
        if (tree.exists(packageJsonPath)) {
            packageJson = JSON.parse((_a = tree.read(`${getBasePath(options)}/package.json`)) === null || _a === void 0 ? void 0 : _a.toString());
        }
        const style = getStyle(workspace, options);
        for (const rule of options.compilerFlags) {
            tsConfig.compilerOptions[rule] = false;
        }
        tsConfig.compilerOptions.strictPropertyInitialization = !options.compilerFlags.find(flag => flag === 'strictNullChecks');
        if (options.new) {
            options.style = style.rules;
        }
        options.docTitle = options.docTitle || `${options.name} Documentation`;
        const templateOptions = Object.assign(Object.assign(Object.assign({}, options), {
            headers: parseHeaders(options),
            style: style.rules,
            whitelist: JSON.stringify(Object.keys(packageJson.devDependencies))
        }), { classify: core_1.strings.classify, dasherize: core_1.strings.dasherize });
        if (style.syntax !== 'css') {
            templateOptions.postprocessor = `"*.{${style.syntax},css}": [
        "stylelint",
      ],`;
        }
        else {
            templateOptions.postprocessor = `"*.css": [
        "stylelint --syntax=css",
      ],`;
        }
        const rules = [
            schematics_1.template(templateOptions),
            schematics_1.filter((path) => {
                if (options.useMd) {
                    return true;
                }
                else {
                    return path !== '/mdlint.json';
                }
            }),
            schematics_1.filter((path) => {
                if (options.linter === 'eslint') {
                    return path !== '/tslint.json';
                }
                else {
                    return path !== '/.eslintrc.js';
                }
            }),
            schematics_1.filter((path) => {
                if (options.cypressPort) {
                    return true;
                }
                else {
                    return path !== '/cypress.json' && !path.includes('/tests');
                }
            }),
            schematics_1.filter((path) => {
                if (options.overwrite) {
                    return true;
                }
                else {
                    return !tree.exists(path);
                }
            }),
            schematics_1.filter((path) => {
                if (options.a11y) {
                    return true;
                }
                else {
                    return path !== '/pa11y.json';
                }
            }),
            schematics_1.filter((path) => {
                if (options.sonarId) {
                    return true;
                }
                else {
                    return path !== '/sonar-project.properties';
                }
            }),
            schematics_1.filter((path) => {
                if (!options.customWebpack) {
                    return true;
                }
                else {
                    return path !== '/tests/coverage.webpack.js';
                }
            }),
            schematics_1.filter((path) => {
                const blistpath = '/browserslist';
                if (!tree.exists(blistpath)) {
                    return true;
                }
                else {
                    return path !== blistpath;
                }
            }),
            schematics_1.filter((path) => {
                if (style.syntax !== 'styl') {
                    return true;
                }
                else {
                    return path !== '/.stylelintrc';
                }
            })
        ];
        _context.addTask(new tasks_1.NodePackageInstallTask({
            packageManager: options.packageMgr,
            workingDirectory: options.new ? options.name : '.',
            quiet: true
        }));
        if (options.useSnyk) {
            _context.addTask(new tasks_1.RunSchematicTask('command', { command: isWindows() ? 'npx.cmd' : 'npx', args: ['snyk', 'auth'] }));
        }
        const source = schematics_1.url('./files');
        const commonRules = [
            installPackages(tree, _context, options),
            addCompoDocScripts(options, tree),
            addWebpackBundleAnalyzerScripts(options),
            addLintScripts(options, workspace),
            addNpmAudit(options),
        ];
        if (options.useSnyk) {
            commonRules.push(addSnykMonitor(options));
        }
        if (options.docDir) {
            commonRules.push(updateGitIgnore([options.docDir.charAt(0) === '.' ? options.docDir.substr(1) : options.docDir], options));
        }
        if (!options.new && options.customWebpack) {
            commonRules.push(updateWebpackConfig(options.customWebpack));
        }
        if (options.a11y) {
            commonRules.push(addPa11y(options));
        }
        if (options.saveConfig) {
            commonRules.push(updateJSONFile(configPath, lodash_1.omit(options, 'new'), tree.exists(configPath)));
        }
        if (options.cypressPort) {
            commonRules.push(addCypressScripts(options), addDevBuilder(options));
        }
        if (options.overwrite) {
            return schematics_1.chain([
                ...commonRules,
                updateJSONFile(`${getBasePath(options)}/tsconfig.json`, tsConfig),
                applyWithOverwrite(source, rules, options)
            ]);
        }
        else {
            return schematics_1.chain([
                ...commonRules,
                schematics_1.move(core_1.normalize(getBasePath(options))),
                schematics_1.mergeWith(schematics_1.apply(source, rules), schematics_1.MergeStrategy.AllowOverwriteConflict)
            ]);
        }
    };
}
exports.codeGuard = codeGuard;
//# sourceMappingURL=index.js.map