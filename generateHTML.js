const fs = require("fs");

function generateHTML(file, domainName) {
  const jsonData = JSON.parse(fs.readFileSync(file, "utf-8"));

  function renderJSON(data) {
    if (Array.isArray(data)) {
      return `<ul>${data
        .map((item) => `<li>${renderJSON(item)}</li>`)
        .join("")}</ul>`;
    } else if (typeof data === "object") {
      const keys = Object.keys(data);
      return `<ul>${keys
        .map(
          (key) => `<li><strong>${key}:</strong> ${renderJSON(data[key])}</li>`
        )
        .join("")}</ul>`;
    } else {
      return `${data}`;
    }
  }

  let htmlContent = `
  <!DOCTYPE html>
  <html lang="en">
  <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>SEOAnalysis for ${domainName}</title>
      <style>
          body { font-family: Arial, sans-serif; padding: 20px; }
          ul { list-style-type: none; padding-left: 20px; }
          li { padding: 5px 0; }
          strong { font-weight: bold; }
      </style>
  </head>
  <body>
      <h1>SEOAnalysis for ${domainName}</h1>
      ${renderJSON(jsonData.analysis.details)}
  </body>
  </html>`;

  fs.writeFileSync(`${domainName}.html`, htmlContent);
}

module.exports = { generateHTML };
