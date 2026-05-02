#!/usr/bin/env node

process.env.OPEN_ON_START = process.env.OPEN_ON_START || "1";
require("./launcher").installLauncher();
require("../server");
