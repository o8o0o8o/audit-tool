const { spawn } = require("child_process");

async function audit(restoredOrigin, restoredProceed) {
  try {
    const origin = restoredOrigin ?? process.argv[2];
    const proceed = restoredProceed ?? process.argv[3];

    const child = spawn("node", ["robots.js", origin, proceed], {
      stdio: "inherit",
    });

    child.on("exit", async (code) => {
      if (code !== 0) {
        child.kill();

        console.log("Restarting...");

        await audit(origin, "--proceed");
      }

      console.log("+++++++++++++++++++++++++++++++ ERROR CODE: " + code);
    });
  } catch (error) {
    console.log(error);
  }

  // TODO: generate PDF
}

audit();
