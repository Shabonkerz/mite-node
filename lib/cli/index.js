#!/usr/bin/env node

require("../requireExtensions");

var program = require("commander"),
	path = require("path"),
	os = require("os"),
	reporter = require("./reporter"),
	fs = require("fs"),
	q = require("q"),
	_ = require("underscore"),
	mitePackage = require(path.join(__dirname, "../", "../", "package.json")),
	defaults = require(path.join(__dirname, "../", "../", "defaults.json")),
	format = require("util").format,
	cliUtil = require("./util"),
	handleError = cliUtil.handleError,
	forceExit = cliUtil.forceExit,
	windowsStyleRoot = /^[a-zA-Z1-9_]+:\\$/;

var UpCommand = require("./up"),
	StatusCommand = require("./status"),
	CreateCommand = require("./create"),
	StepUpCommand = require("./stepUp"),
	StepDownCommand = require("./stepDown"),
	InitCommand = require("./init"),
	DownCommand = require("./down"),
	AuditCommand = require("./audit");

/* constants */
var CONFIG_FILENAMES = [".mite", "mite.config"],
	DEFAULT_CONFIG_NAME = ".mite";


program
	.version(mitePackage.version);

program
	.command("status")
	.description("show migration status")
	.action(function() {
		runCommand(new StatusCommand());
	});

program
	.command("init")
	.description("init the _migration table and migrations directory")
	.action(function() {
		runCommand(new InitCommand({}), { requireConfig: false });
	});

program
	.command("up")
	.description("run all unexecuted migrations")
	.action(function() {
		runCommand(new UpCommand());
	});

/*
	TODO: I would rather the syntax be "mite step up", "mite step down", "mite step to 2014-02-18T05:29:39.686Z", etc...
	investigate the best way to configure sub commands.
*/
program
	.command("stepup")
	.description("run the first unexecuted migration")
	.action(function() {
		runCommand(new StepUpCommand());
	});

var downCli = program
	.command("down")
	.description("run all the down migrations")
	.option("-C --confirm", "comfirm potentially dangerous operation")
	.action(function() {
		runCommand(new DownCommand({
			confirmed: downCli.confirm
		}));
	});

var stepDownCli = program
	.command("stepdown")
	.option("-C --confirm", "comfirm potentially dangerous operation")
	.description("step down one migration from the current head")
	.action(function() {
		runCommand(new StepDownCommand({
			confirmed: stepDownCli.confirm
		}));
	});


var createCli = program
	.command("create")
	.option("-O --open", "open the new migration after creating it")
	.description("create a new (empty) migration file")
	.action(function() {
		runCommand(new CreateCommand({
			open: createCli.open
		}));
	});

program
	.command("help [command]")
	.description("display general usage information, or usage info for a specific command")
	.action(function(arg, ignore) {
		if(arg === "down") {
			downCli.help();
		} else if(arg === "stepdown") {
			stepDownCli.help();
		} else if(arg === "create") {
			createCli.help();
		} else {
			program.help();
		}
	});


program
	.command("audit")
	.description("determine what's wrong with your schema")
	.action(function() {
		runCommand(new AuditCommand());
	});


program
	.command("*")
	.action(function(arg) {
		reporter.err("invalid command: '%s'", arg);
		program.help();
	});

program.parse(process.argv);

// if `mite` was executed with no args, show usage info
// this will totally cause issues if we add add options/flags that don't require a command, e.g.: `mite --foo`
if(program.args.length === 0) {
	reporter.err("empty/missing command");
	program.help();
	process.exit(1);
}

function isWindowsStyleRoot(dir) {
	return windowsStyleRoot.test(dir);
}



function getMiteRoot(dir, opts) {
	dir = dir || process.cwd();
	var prev = null,
		root;

	while (prev !== "/" && dir !== "/" && !isWindowsStyleRoot(prev) && !isWindowsStyleRoot(dir)) {
		var files = fs.readdirSync(dir);

		if (files.some(function(x) {
			return CONFIG_FILENAMES.indexOf(x) !== -1;
		})) {
			root = dir;
			break;
		} else {
			prev = dir;
			dir = path.join(dir, "../");
		}
	}

	if(!root && opts.requireConfig) {
		throw format("not a mite project (or any of the parent directories):", CONFIG_FILENAMES.join(", "));
	} else return root;
}

function getMiteConfig(root) {
	root = root || path.resolve(".");

	var configPaths = CONFIG_FILENAMES.map(function(name) {return path.join(root, name);}),
		userConfigRaw,
		userConfig;

	// first path that exists
	var configPath = configPaths.filter(function(p) {
		return fs.existsSync(p);
	})[0];

	if(configPath) {
		userConfigRaw = fs.readFileSync(configPath, "utf8");

		try {
			userConfig = JSON.parse(userConfigRaw);
		} catch (e) {
			throw format("invalid json in mite.config (%s)", configPath);
		}
	}

	var cfg = _.extend({}, defaults, userConfig || {});
	cfg.migrationRoot = path.join(root, cfg.migrationFolderName);
	cfg.configExists = !!userConfig;
	cfg.miteRoot = root ? root : ".";
	cfg.CONFIG_FILENAMES = CONFIG_FILENAMES;
	cfg.DEFAULT_CONFIG_NAME = DEFAULT_CONFIG_NAME;

	var platform = os.type().toLowerCase();
	switch(platform) {
		case "darwin":
			platform = "osx";
			break;
		case "windows_nt":
			platform = "windows";
			break;
		default:
			break;
	}
	cfg.platform = platform;

	return cfg;
}

function runCommand(command, opts) {
	opts = _.extend({
		requireConfig: true
	}, opts);

	promisfy(getMiteRoot, null, [null, opts]).then(function (root) {
		return promisfy(getMiteConfig, null, [root, opts]);
	}).then(function (cfg) {
		return promisfy(command.preExecute, command, [cfg]);
	}).then(function (m) {
		return promisfy(command.execute, command, [m]);
	}).then(function (arg) {
		return (command.dispose || function(){})(arg);
	}).fail(function (err) {
		reporter.err("fatal: %s", err instanceof Error ? err.messge : err);
		forceExit(1);
	}).fin(forceExit);
}

function promisfy(func, thisarg, args) {
	var def = q.defer();

	try {
		def.resolve(func.apply(thisarg, args));
	} catch(e) {
		def.reject(e);
	}

	return def.promise;
}
