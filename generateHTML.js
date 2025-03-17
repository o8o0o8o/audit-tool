const fs = require("fs");

function generateHTML(file, domainName) {
  const jsonData = JSON.parse(fs.readFileSync(file, "utf-8"));

  function renderJSON(data) {
    if (Array.isArray(data)) {
      return `<ul class="accordion-content">${data
        .map((item) => `<li>${renderJSON(item)}</li>`)
        .join("")}</ul>`;
    } else if (typeof data === "object") {
      const keys = Object.keys(data);
      return `<ul>${keys
        .map(
          (key) =>
            `<li class="accordion-item"><button class="accordion-header">${key}</button>${renderJSON(
              data[key]
            )}</li>`
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
          .accordion-item {
            border-bottom: 1px solid #ddd;
        }
        .accordion-header {
            width: 100%;
            padding: 10px;
            text-align: left;
            background: #f8f8f8;
            border: none;
            cursor: pointer;
            font-size: 16px;
        }
        .accordion-content {
            max-height: 0;
            overflow: hidden;
            transition: max-height 0.3s ease-out;
            padding: 0 10px;
            background: #fff;
        }
      </style>
  </head>
  <body>
      <h1>SEOAnalysis for ${domainName}</h1>
      ${renderJSON(jsonData.analysis.details)}
    <script>
      document.querySelectorAll(".accordion-header").forEach(button => {
        button.addEventListener("click", () => {
          const content = button.nextElementSibling;
          const isOpen = content.style.maxHeight;

          document.querySelectorAll(".accordion-content").forEach(item => {
            item.style.maxHeight = null;
          });

          if (!isOpen) {
            content.style.maxHeight = content.scrollHeight + "px";
          }
        });
      });
    </script>
  </body>
  </html>`;

  fs.writeFileSync(`${domainName}.html`, htmlContent);
}

module.exports = { generateHTML };
