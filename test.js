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
  const httpServer = http.createServer(requestHandler);
  const httpsServer = https.createServer(sslOptions, requestHandler);

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

function requestHandler(req, res) {
  if (bprecvfileProcess) {
    console.log(`[${new Date().toLocaleString()}] New request received. Terminating bprecvfile process.`);
    bprecvfileProcess.kill('SIGKILL');
    bprecvfileProcess = null;
  }

  const clientIp = req.socket.remoteAddress;
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
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
        logAndHandleRequest(req, res, clientIp);
      }
    } else {
      logAndHandleRequest(req, res, clientIp);
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
          logAndHandleRequest(req, res, clientIp);
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

function logAndHandleRequest(req, res, clientIp) {
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
    const fullUrl = `http://${hostHeader}${req.url}`;
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
  const newFilename = `response_${Date.now()}.txt`;
  const newFilePath = path.join(fileDirectory, newFilename);
  const extractPath = path.join(fileDirectory, 'extracted');

  fs.rename(filePath, newFilePath, (renameError) => {
    if (renameError) {
      console.error(`Error renaming file: ${renameError}`);
      return;
    }

    if (!fs.existsSync(extractPath)) {
      fs.mkdirSync(extractPath, { recursive: true });
    }

    fs.createReadStream(newFilePath)
      .pipe(unzipper.Extract({ path: extractPath }))
      .on('close', () => {
        console.log(`${newFilename} has been extracted to ${extractPath}`);
        mergeExtractedFiles(extractPath);
      })
      .on('error', (err) => console.error('Error extracting file:', err));
  });
}

function mergeExtractedFiles(extractPath) {
  fs.readdir(extractPath, { withFileTypes: true }, (err, entries) => {
    if (err) {
      console.error(`Error reading extracted directory: ${err}`);
      return;
    }
    entries.forEach(entry => {
      if (entry.isDirectory()) {
        const extractedDirPath = path.join(extractPath, entry.name);
        const targetDirPath = path.join(fileDirectory, entry.name);
        if (fs.existsSync(targetDirPath)) {
          mergeDirectories(extractedDirPath, targetDirPath);
        } else {
          moveDirectory(extractedDirPath, targetDirPath);
        }
      }
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

  exec(`sudo bpsendfile ipn:150.1 ipn:149.2 ${filePath}`, (error, stdout, stderr) => {
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
