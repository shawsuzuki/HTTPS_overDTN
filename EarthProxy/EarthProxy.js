const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const archiver = require('archiver');

const fileDirectory = './nodejs';
const processedFiles = new Set();

const execAsync = promisify(exec);
const renameAsync = promisify(fs.rename);
const readFileAsync = promisify(fs.readFile);
const readdirAsync = promisify(fs.readdir);
const mkdirAsync = promisify(fs.mkdir);
const statAsync = promisify(fs.stat);

// bprecvfileによるtestfileの受信を検知
fs.watch(fileDirectory, async (eventType, filename) => {
    if (eventType === 'rename' && filename.startsWith('testfile')) {
        if (processedFiles.has(filename) || filename.includes('_processing')) {
            return; // 既に処理中または処理済みのファイルは無視
        }

        processedFiles.add(filename); // 処理するファイルを記録
        await processFile(filename);
    }
});

// testfileを受信した時のファイルの処理。fs.watchにより最初に呼び出す
async function processFile(filename) {
    const processingFilename = filename + '_processing';
    const originalFilePath = path.join(fileDirectory, filename);
    const processingFilePath = path.join(fileDirectory, processingFilename);

    try {
        // ファイル名を変更して処理中にマーク
        const filesBefore = await readdirAsync(fileDirectory);
        console.log(`[${new Date().toLocaleString()}] Directory content before rename: ${filesBefore.join(', ')}`);

        await renameAsync(originalFilePath, processingFilePath);
        console.log(`[${new Date().toLocaleString()}] File renamed for processing: ${processingFilePath}`);

        const filesAfter = await readdirAsync(fileDirectory);
        console.log(`[${new Date().toLocaleString()}] Directory content after rename: ${filesAfter.join(', ')}`);

        //
        await waitForFileSizeStability(processingFilePath); // ファイルサイズの安定を待つ

        await readAndProcessFile(processingFilePath); 
    } catch (err) {
        console.error(`[${new Date().toLocaleString()}] Error processing file: ${err}`);
    }
}

// ファイルサイズの安定を待つ。書き込み中にsendされることによるSDR防止のため。processFile関数で呼び出す
async function waitForFileSizeStability(filePath, interval = 1000, maxRetries = 5) {
    let previousSize = -1;
    for (let i = 0; i < maxRetries; i++) {
        const { size } = await statAsync(filePath);
        if (size === previousSize) {
            return; // ファイルサイズが安定している
        }
        previousSize = size;
        await new Promise(resolve => setTimeout(resolve, interval)); // インターバルを待つ
    }
    throw new Error(`File size did not stabilize: ${filePath}`);
}

// ファイルの中身を読み込み、処理する関数。processFile関数で呼び出す
async function readAndProcessFile(filePath) {
    try {
        const data = await readFileAsync(filePath, 'utf8');
        console.log(`[${new Date().toLocaleString()}] Raw file data: ${data}`);

        const lines = data.split('\n');
        console.log(`[${new Date().toLocaleString()}] Split lines: ${lines}`);

        const requestLine = lines.find(line => line.startsWith("IncomingRequest="));
        if (!requestLine) {
            console.error(`[${new Date().toLocaleString()}] 'IncomingRequest=' not found in file: ${filePath}`);
            return;
        }

        const { url, requestBody, requestId } = extractRequestDetails(requestLine);
        console.log(`[${new Date().toLocaleString()}] Extracted URL: ${url}`);
        console.log(`[${new Date().toLocaleString()}] Extracted Request Body: ${requestBody}`);
        console.log(`[${new Date().toLocaleString()}] Extracted Request ID: ${requestId}`);

        if (url && requestId) {
            await handleRequest(url, filePath, requestId); // リクエストの処理を開始
        } else {
            console.error(`[${new Date().toLocaleString()}] URL or ID not found in file: ${filePath}`);
        }
    } catch (err) {
        console.error(`[${new Date().toLocaleString()}] Error reading file: ${err}`);
    }
}

//リクエストの処理をメインでやる関数。readAndProcessFile関数で呼び出す
async function handleRequest(url, processingFilePath, requestId) {
    const downloadDir = path.join(fileDirectory, `download_${Date.now()}`);
    const zipFileNamePrefix = `processed_${requestId}`;
    
    try {
        await mkdirAsync(downloadDir, { recursive: true });
        await downloadContent(url, downloadDir);
        
        const dividedDirs = await divideFiles(downloadDir);
        
        for (let i = 0; i < dividedDirs.length; i++) {
            const zipFileName = `${zipFileNamePrefix}_${i + 1}.zip`;
            const zipFilePath = path.join(fileDirectory, zipFileName);
            
            await zipDirectory(dividedDirs[i], zipFilePath);
            await sendFile(zipFilePath, zipFileName);
        }
    } catch (err) {
        console.error(`[${new Date().toLocaleString()}] Error handling request: ${err}`);
    }
}

// 新しい関数 divideFiles を追加
async function divideFiles(sourceDir, maxSizeKB = 500) {
    const dividedDirs = [];
    let currentDir = path.join(fileDirectory, `divided_${Date.now()}`);
    let currentSize = 0;

    await mkdirAsync(currentDir, { recursive: true });
    console.log(`[${new Date().toLocaleString()}] Created directory: ${currentDir}`);

    const files = await getAllFiles(sourceDir);
    console.log(`[${new Date().toLocaleString()}] Files in source directory: ${files.join(', ')}`);

    for (const filePath of files) {
        const fileStat = await statAsync(filePath);
        console.log(`[${new Date().toLocaleString()}] File: ${filePath}, Size: ${fileStat.size} bytes`);

        if (currentSize + fileStat.size / 1024 > maxSizeKB) {
            dividedDirs.push(currentDir);
            console.log(`[${new Date().toLocaleString()}] Current directory: ${currentDir} reached max size`);
            currentDir = path.join(fileDirectory, `divided_${Date.now()}`);
            await mkdirAsync(currentDir, { recursive: true });
            currentSize = 0;
            console.log(`[${new Date().toLocaleString()}] Created new directory: ${currentDir}`);
        }

        await moveFileWithDirStructure(filePath, currentDir, sourceDir); // currentDir を引数として渡す
        console.log(`[${new Date().toLocaleString()}] Moved file: ${filePath} to ${currentDir}`);
        currentSize += fileStat.size / 1024;
        console.log(`[${new Date().toLocaleString()}] Current directory size: ${currentSize} KB`);
    }

    if (currentSize > 0) {
        dividedDirs.push(currentDir);
        console.log(`[${new Date().toLocaleString()}] Final directory: ${currentDir} added`);
    }

    console.log(`[${new Date().toLocaleString()}] Divided directories: ${dividedDirs.join(', ')}`);
    return dividedDirs;
}





// URLからコンテンツをダウンロード 
async function downloadContent(url, downloadDir) {
    const wgetCommand = `wget -r -l 1 -np -P "${downloadDir}" "${url}"`; // -r: recursive, -l 1: max depth 1, -np: no parent, -p: download page requisites
    try {
        const { stdout, stderr } = await execAsync(wgetCommand);
        if (stderr) {
            console.error(`[${new Date().toLocaleString()}] wget stderr: ${stderr}`);
        }
        console.log(`[${new Date().toLocaleString()}] Content downloaded: ${stdout}`);
    } catch (error) {
        console.error(`[${new Date().toLocaleString()}] Error executing wget for ${url}: ${error.message}`);
    }
}

// ディレクトリをZIPファイルに圧縮
async function zipDirectory(sourceDir, zipFilePath) {
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(zipFilePath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => {
            console.log(`[${new Date().toLocaleString()}] Directory zipped successfully: ${zipFilePath}`);
            resolve();
        });

        archive.on('error', (err) => {
            console.error(`[${new Date().toLocaleString()}] Archiver error: ${err.message}`);
            reject(err);
        });

        archive.pipe(output);
        archive.directory(sourceDir, false);
        archive.finalize();
    });
}

//bpsendfileを実行 送信先はipn:150.2
async function sendFile(filePath, zipFileName) {
    const command = `cd ${fileDirectory} && bpsendfile ipn:149.1 ipn:150.2 ${zipFileName}`;
    try {
        const { stdout, stderr } = await execAsync(command);
        if (stderr) {
            console.error(`[${new Date().toLocaleString()}] bpsendfile stderr: ${stderr}`);
        }
        console.log(`[${new Date().toLocaleString()}] bpsendfile executed for ${filePath}: ${stdout}`);
    } catch (error) {
        console.error(`[${new Date().toLocaleString()}] Error executing bpsendfile: ${error.message}`);
    }
}

//ファイルの中身のparseする関数。readAndProcessFile関数で呼び出す
function extractRequestDetails(requestLine) {
    const parts = requestLine.substring("IncomingRequest=".length).split(',');
    console.log(`[${new Date().toLocaleString()}] Parts after split by ',': ${parts}`);

    const url = parts[0] ? parts[0].trim() : null;
    const requestBody = parts[1] ? parts[1].trim() : null;
    const requestId = requestBody ? requestBody.split('=')[1] : null;

    console.log(`[${new Date().toLocaleString()}] Extracted URL: ${url}`);
    console.log(`[${new Date().toLocaleString()}] Extracted Request Body: ${requestBody}`);
    console.log(`[${new Date().toLocaleString()}] Extracted Request ID: ${requestId}`);

    return { url, requestBody, requestId };
}

// 既存の moveFileWithDirStructure 関数を更新
async function moveFileWithDirStructure(sourcePath, targetDir, currentDir) {
    const relativePath = path.relative(currentDir, sourcePath); // currentDir を基準に相対パスを計算
    const targetPath = path.join(targetDir, relativePath);
    const targetDirPath = path.dirname(targetPath);

    console.log(`[${new Date().toLocaleString()}] Source path: ${sourcePath}`);
    console.log(`[${new Date().toLocaleString()}] Relative path: ${relativePath}`);
    console.log(`[${new Date().toLocaleString()}] Target path: ${targetPath}`);
    console.log(`[${new Date().toLocaleString()}] Target directory path: ${targetDirPath}`);

    await mkdirAsync(targetDirPath, { recursive: true });
    console.log(`[${new Date().toLocaleString()}] Created directory: ${targetDirPath}`);

    await renameAsync(sourcePath, targetPath);
    console.log(`[${new Date().toLocaleString()}] Moved file: ${sourcePath} to ${targetPath}`);
}




async function getAllFiles(dir) {
    let results = [];
    const list = await readdirAsync(dir, { withFileTypes: true });
    console.log(`[${new Date().toLocaleString()}] Reading directory: ${dir}`);
    for (const file of list) {
        const filePath = path.join(dir, file.name);
        const stat = await statAsync(filePath);
        if (stat && stat.isDirectory()) {
            console.log(`[${new Date().toLocaleString()}] Directory: ${filePath}`);
            const res = await getAllFiles(filePath);
            results = results.concat(res);
        } else {
            console.log(`[${new Date().toLocaleString()}] File: ${filePath}`);
            results.push(filePath);
        }
    }
    return results;
}


// bprecvfileを実行 受信はipn:149.2
function executeBprecvfile() {
    const command = `cd ${fileDirectory} && bprecvfile ipn:149.2`;
    console.log(`[${new Date().toLocaleString()}] started new listening session: ${command}`);
    exec(command, (error, stdout, stderr) => {
        if (stderr) {
            console.error(`[${new Date().toLocaleString()}] bprecvfile stderr: ${stderr}`);
        }
        console.log(`[${new Date().toLocaleString()}] bprecvfile executed: ${stdout}`);
    });
}

executeBprecvfile();