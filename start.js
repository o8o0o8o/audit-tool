const { spawn } = require("child_process");

async function audit(restoredOrigin, restoredProceed, restoredPerf) {
  try {
    const origin = restoredOrigin ?? process.argv[2];
    const proceed = restoredProceed ?? process.argv[3];
    const perf = restoredPerf ?? process.argv[4];

    const child = spawn("node", ["robots.js", origin, proceed, perf], {
      stdio: "inherit",
    });

    child.on("exit", async (code) => {
      if (code !== 0) {
        child.kill();

        console.log("Restarting...");

        await audit(origin, "--proceed", perf);
      }

      console.log("+++++++++++++++++++++++++++++++ ERROR CODE: " + code);
    });
  } catch (error) {
    console.log(error);
  }
}

audit();
