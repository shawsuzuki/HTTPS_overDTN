const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const unzipper = require('unzipper');

const sslOptions = {
  key: fs.readFileSync('server.key'),
  cert: fs.readFileSync('server.crt')
};

const fileDirectory = './nodejs';
const clientConnections = new Map();
let savedHttpResponse = '';
let bprecvfileProcess = null;

initializeServers();
initializeFileWatcher();
executeBprecvfile();

function initializeServers() {
  const httpServer = http.createServer((req, res) => requestHandler(req, res, 'http'));
  const httpsServer = https.createServer(sslOptions, (req, res) => requestHandler(req, res, 'https'));

  httpServer.listen(80, '0.0.0.0', () => {
    console.log('HTTP Server listening on port 80');
  });

  httpsServer.listen(443, '0.0.0.0', () => {
    console.log('HTTPS Server listening on port 443');
  });
}

function executeBprecvfile() {
  const command = `cd ${fileDirectory} && bprecvfile ipn:150.2`;
  console.log(`[${new Date().toLocaleString()}] started new listening session: ${command}`);
  bprecvfileProcess = exec(command, (error, stdout, stderr) => {
    if (error) {
      console.error(`[${new Date().toLocaleString()}] Error executing bprecvfile: ${error.message}`);
      return;
    }
    if (stderr) {
      console.error(`[${new Date().toLocaleString()}] bprecvfile stderr: ${stderr}`);
    }
    console.log(`[${new Date().toLocaleString()}] bprecvfile executed: ${stdout}`);
  });
}

function requestHandler(req, res, protocol) {
  if (bprecvfileProcess) {
    console.log(`[${new Date().toLocaleString()}] New request received. Terminating bprecvfile process.`);
    bprecvfileProcess.kill('SIGKILL');
    bprecvfileProcess = null;
  }

  const clientIp = req.socket.remoteAddress;
  const parsedUrl = new URL(req.url, `${protocol}://${req.headers.host}`);
  console.log(`Received request from ${clientIp} for host: ${parsedUrl.hostname}`);
  console.log(`Full request URL: ${parsedUrl.href}`);

  const hostBasedDirectory = path.join(fileDirectory, parsedUrl.hostname);
  const sanitizedPath = path.normalize(parsedUrl.pathname).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(hostBasedDirectory, sanitizedPath);

  fs.stat(filePath, (err, stats) => {
    if (!err) {
      if (stats.isDirectory()) {
        handleDirectoryRequest(res, filePath);
      } else if (stats.isFile()) {
        serveFile(res, filePath);
      } else {
        logAndHandleRequest(req, res, clientIp, protocol);
      }
    } else {
      logAndHandleRequest(req, res, clientIp, protocol);
    }
  });

  req.on('error', error => {
    console.error(`Request error from ${clientIp}: ${error.message}`);
  });

  res.on('error', error => {
    console.error(`Response error to ${clientIp}: ${error.message}`);
  });

  clientConnections.set(clientIp, res);

  req.on('close', () => {
    clientConnections.delete(clientIp);
    console.log(`Closed connection from ${clientIp}`);
  });
}

function handleDirectoryRequest(res, dirPath) {
  const indexFilePath = path.join(dirPath, 'index.html');
  fs.stat(indexFilePath, (err, stats) => {
    if (!err && stats.isFile()) {
      serveFile(res, indexFilePath);
    } else {
      findIndexHtml(dirPath, (err, indexPath) => {
        if (err) {
          logAndHandleRequest(req, res, clientIp, protocol);
        } else {
          serveFile(res, indexPath);
        }
      });
    }
  });
}

function serveFile(res, filePath) {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  fs.createReadStream(filePath).pipe(res);
}

function findIndexHtml(dirPath, callback) {
  fs.readdir(dirPath, { withFileTypes: true }, (err, entries) => {
    if (err) {
      return callback(err);
    }
    var found = false;
    entries.forEach(entry => {
      if (found) return;
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        findIndexHtml(fullPath, callback);
      } else if (entry.isFile() && entry.name === 'index.html') {
        found = true;
        callback(null, fullPath);
      }
    });
    if (!found && entries.length === 0) {
      callback(new Error('No index.html found'));
    }
  });
}

function logAndHandleRequest(req, res, clientIp, protocol) {
  let requestBody = '';
  req.on('data', chunk => {
    requestBody += chunk.toString();
  });

  req.on('end', () => {
    const timestamp = new Date().toISOString();
    const filename = `request_${timestamp.replace(/:/g, '-')}.txt`;
    const filePath = path.join(fileDirectory, filename);

    const randomId = generateRandomId();
    const hostHeader = req.headers['host'];
    const fullUrl = `${protocol}://${hostHeader}${req.url}`;
    const requestDetails = `IncomingRequest=${fullUrl},id=${randomId}`;

    fs.writeFile(filePath, requestDetails, error => {
      if (error) {
        console.error(`Error writing file for ${clientIp}: ${error.message}`);
        res.writeHead(500);
        res.end('Internal Server Error');
      } else {
        console.log(`Request from ${clientIp} written to file ${filename}`);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(savedHttpResponse || `Received request at ${new Date().toISOString()}`);
      }
    });
  });
}

function generateRandomId() {
  return Math.floor(Math.random() * 100000000).toString().padStart(7, '0');
}

function initializeFileWatcher() {
  fs.watch(fileDirectory, (eventType, filename) => {
    if (eventType === 'rename') {
      handleFileWatch(filename);
    }
  });
}

function handleFileWatch(filename) {
  if (filename.startsWith('testfile')) {
    handleTestFile(filename);
  } else if (filename.startsWith('request_')) {
    handleRequestFile(filename);
  }
}

function handleTestFile(filename) {
  const filePath = path.join(fileDirectory, filename);
  const newFilename = `response_${Date.now()}.zip`;
  const newFilePath = path.join(fileDirectory, newFilename);

  fs.rename(filePath, newFilePath, (renameError) => {
    if (renameError) {
      console.error(`Error renaming file: ${renameError}`);
      return;
    }

    // unzipコマンドを使用してファイルを./nodejsに解凍
    const unzipCommand = `unzip -o ${newFilePath} -d ${fileDirectory}`;
    exec(unzipCommand, (unzipError, stdout, stderr) => {
      if (unzipError) {
        console.error(`Error unzipping file: ${unzipError}`);
        return;
      }
      if (stderr) {
        console.error(`Unzip stderr: ${stderr}`);
      }
      console.log(`Unzipped ${newFilename} to ${fileDirectory}: ${stdout}`);
    });
  });
}


function moveExtractedFiles(extractPath, newFilename) {
  console.log(`extractPath: ${extractPath}`);
  console.log(`newFilename: ${newFilename}`);

  fs.readdir(extractPath, { withFileTypes: true }, (err, entries) => {
    if (err) {
      console.error(`Error reading extracted directory: ${err}`);
      return;
    }

    console.log(`Top-level entries: ${entries.map(entry => entry.name).join(', ')}`);

    // assume there is only one top-level directory which contains the actual domain directory
    const topLevelDir = entries.find(entry => entry.isDirectory());
    if (!topLevelDir) {
      console.error('No top-level directory found');
      return;
    }

    const topLevelDirPath = path.join(extractPath, topLevelDir.name);
    console.log(`Processing top-level directory: ${topLevelDirPath}`);
    
    fs.readdir(topLevelDirPath, { withFileTypes: true }, (err, subEntries) => {
      if (err) {
        console.error(`Error reading top-level directory: ${err}`);
        return;
      }

      console.log(`Sub-entries in ${topLevelDirPath}: ${subEntries.map(subEntry => subEntry.name).join(', ')}`);

      if (topLevelDir.name.startsWith('download') || topLevelDir.name.startsWith('download')) {
        subEntries.forEach(subEntry => {
          const extractedDirPath = path.join(topLevelDirPath, subEntry.path);
          const domainName = subEntry.name;
          const domainPath = path.join(fileDirectory, 'extracted', domainName);

          console.log(`Extracted path: ${extractedDirPath}`);
          console.log(`Domain name: ${domainName}`);
          console.log(`Domain path: ${domainPath}`);

          if (subEntry.isDirectory()) {
            if (fs.existsSync(extractedDirPath)) {
              if (!fs.existsSync(domainPath)) {
                console.log(`Creating directory: ${domainPath}`);
                fs.mkdirSync(domainPath, { recursive: true });
              }
              console.log(`Merging directory: ${extractedDirPath} into ${domainPath}`);
              mergeDirectories(extractedDirPath, domainPath);
            } else {
              console.error(`Directory does not exist: ${extractedDirPath}`);
            }
          } else {
            if (fs.existsSync(extractedDirPath)) {
              console.log(`Moving file: ${extractedDirPath} to ${domainPath}`);
              fs.rename(extractedDirPath, domainPath, (err) => {
                if (err) {
                  console.error(`Error moving file: ${err}`);
                }
              });
            } else {
              console.error(`File does not exist: ${extractedDirPath}`);
            }
          }
        });
      } else {
        subEntries.forEach(subEntry => {
          const extractedDirPath = path.join(topLevelDirPath, subEntry.name);
          const domainName = topLevelDir.name; // 上位ディレクトリからドメイン名を取得
          const domainPath = path.join(fileDirectory, 'extracted', domainName);

          console.log(`Extracted path: ${extractedDirPath}`);
          console.log(`Domain name: ${domainName}`);
          console.log(`Domain path: ${domainPath}`);

          if (subEntry.isDirectory()) {
            if (fs.existsSync(extractedDirPath)) {
              if (!fs.existsSync(domainPath)) {
                console.log(`Creating directory: ${domainPath}`);
                fs.mkdirSync(domainPath, { recursive: true });
              }
              console.log(`Merging directory: ${extractedDirPath} into ${domainPath}`);
              mergeDirectories(extractedDirPath, domainPath);
            } else {
              console.error(`Directory does not exist: ${extractedDirPath}`);
            }
          } else {
            if (fs.existsSync(extractedDirPath)) {
              console.log(`Moving file: ${extractedDirPath} to ${domainPath}`);
              fs.rename(extractedDirPath, path.join(domainPath, subEntry.name), (err) => {
                if (err) {
                  console.error(`Error moving file: ${err}`);
                }
              });
            } else {
              console.error(`File does not exist: ${extractedDirPath}`);
            }
          }
        });
      }
      entries.length = 0;
      console.log('Entries have been reset.');
    });
  });
}




function mergeDirectories(srcDir, destDir) {
  fs.readdir(srcDir, (err, files) => {
    if (err) {
      console.error(`Error reading files for merging: ${err}`);
      return;
    }
    let movedFiles = 0;
    files.forEach(file => {
      const srcFile = path.join(srcDir, file);
      const destFile = path.join(destDir, file);
      fs.rename(srcFile, destFile, err => {
        if (err) {
          console.error(`Error merging file: ${err}`);
          return;
        }
        console.log(`Merged ${file} into ${destDir}`);
        movedFiles++;
        if (movedFiles === files.length) {
          fs.rmdir(srcDir, { recursive: true }, err => {
            if (err) {
              console.error(`Error removing directory: ${err}`);
            } else {
              console.log(`Removed directory ${srcDir} after merging.`);
            }
          });
        }
      });
    });
    if (files.length === 0) {
      fs.rmdir(srcDir, { recursive: true }, err => {
        if (err) {
          console.error(`Error removing empty directory: ${err}`);
        } else {
          console.log(`Removed empty directory ${srcDir}.`);
        }
      });
    }
  });
}

function moveDirectory(srcDir, destDir) {
  try {
    fs.renameSync(srcDir, destDir);
    console.log(`Moved directory ${srcDir} to ${destDir}`);
  } catch (err) {
    console.error(`Error moving directory: ${err}`);
  }
}

function handleRequestFile(filename) {
  const filePath = path.join(fileDirectory, filename);
  console.log(`New request file detected: ${filename}`);

  exec(`bpsendfile ipn:150.1 ipn:149.2 ${filePath}`, (error, stdout, stderr) => {
    if (error) {
      console.error(`Error executing bpsendfile for ${filename}: ${error.message}`);
      return;
    }
    if (stderr) {
      console.error(`bpsendfile stderr for ${filename}: ${stderr}`);
    }
    console.log(`bpsendfile command executed for ${filename}: ${stdout}`);
  });
}
