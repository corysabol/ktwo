#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const inquirer = require('inquirer');
const chalk = require('chalk');
const figlet = require('figlet');
const kdbxweb = require('kdbxweb');
const { program } = require('commander');
const argon2 = require('kdbxweb/test/test-support/argon2');
const ConfigStore = require('configstore');
const AWS = require('aws-sdk');
const s3 = new AWS.S3();

const PKG_NAME = 'k2';

// hacky use of the test implementation of argon2 found in kdbxweb
kdbxweb.CryptoEngine.argon2 = argon2;

// TODO: Consider implementing storage provider objects under a common interface to facilitate more sync storage options.
// it's possible that the simplest implementation of this idea would be to just implement each provider as a function
// that returns a promise.

/**
 * Pulls a database and it's respective configuration file from the given s3 url.
 * @param {string} s3url - the S3 URL to the db key in S3 e.g. s3://mybucket/k2/mydb
 * @return {Promise}
 */
function pullS3(s3url) {
  let parts = s3url.split('/'),
      bucket = parts[2],
      keyBase = parts.slice(3).reduce((acc, val) => `${acc}/${val}`);
  let dbKey = `${keyBase}/${parts[4]}.kdbx`,
      configKey = `${keyBase}/${parts[4]}.kdbx.json`;
  console.log(parts);
  console.log(dbKey, '\n', configKey);
  let dbPullParams = {
    Bucket: bucket,
    Key: dbKey 
  };
  let dbPromise = s3.getObject(dbPullParams).promise();

  let configPullParams = {
    Bucket: bucket,
    Key: configKey
  };
  let configPromise = s3.getObject(configPullParams).promise();

  return Promise.all([dbPromise, configPromise]);
}

function syncS3(db, config) {
  // https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#putObject-property
  let dbUploadParams = {
    Body: Buffer.from(db),
    Bucket: config.get('syncBucket').split('/').pop(),
    Key: `k2/${config.get('name').split('.')[0]}/${config.get('name')}`,
    //ServerSideEncryption: 'AES256'
    Tagging: "application=k2&type=kdbx4"
  };

  let configUploadParams = {
    Body: fs.readFileSync(config.path),
    Bucket: config.get('syncBucket').split('/').pop(),
    Key: `k2/${config.get('name').split('.')[0]}/${config.get('name')}.json`,
    Tagging: "application=k2&type=k2config"
  };

  let dbUploadPromise = s3.putObject(dbUploadParams).promise();
  let configUploadPromise = s3.putObject(configUploadParams).promise();

  return Promise.all([dbUploadPromise, configUploadPromise]);
}

function getRandomPass() {}

function findGroup() {}

function listGroup() {}

function findEntry() {}

/**
 * Handle merging a local and remote version of a database
 * @param {ArrayBuffer} data - database file contents
 * @param {ArrayBuffer} remoteData - remote database file contents
 * @param {KdbxCredentials} credentials - credentials for both databases
 */
async function mergeDb() {
  let db = await kdbxweb.Kdbx.load(data, credentials); // load local db
  // work with db
  db.save(); // save local db
  let editStateBeforeSave = db.getLocalEditState(); // save local editing state (serializable to JSON)
  db.close(); // close local db
  db = kdbxweb.Kdbx.load(data, credentials); // reopen it again
  db.setLocalEditState(editStateBeforeSave); // assign edit state obtained before save
  // work with db
  let remoteDb = await kdbxweb.Kdbx.load(remoteData, credentials); // load remote db
  db.merge(remoteDb); // merge remote into local
  delete remoteDb; // don't use remoteDb anymore
  let saved = await db.save(); // save local db
  editStateBeforeSave = db.getLocalEditState(); // save local editing state again
  let pushedOk = pushToUpstream(saved); // push db to upstream
  if (pushedOk) {
      db.removeLocalEditState(); // clear local editing state
      editStateBeforeSave = null; // and discard it
  }
}

/** 
 * Get the value of a field in an entry, returns the plain text value of kdbx.ProtectedValue
 * @param {KdbxEntry} entry - the entry to retrieve a field value
 * @param {string} fieldName - the name of the entry field to retreive
 * @return {string} - the value in a field or ''
 */
function entryField(entry, fieldName) {
  const value = entry.fields[fieldName];
  const isProtected = value instanceof kdbxweb.ProtectedValue;
  return (value && isProtected && value.getText()) || value || '';
}

function listEntry(entry, color) {
  let password = entry.fields.Password;
  return  chalk.keyword(color)(
    `  Title:    ${entryField(entry, 'Title')}\n` +
    `  UserName: ${entryField(entry, 'UserName')}\n` +
    `  Password: ${entryField(entry, 'Password')}\n` +
    `  URL:      ${entryField(entry, 'URL')}\n` +
    `  Notes:    ${entryField(entry, 'Notes')}\n`
  );
}

function ask(prompt, type) {
  const questions = [
    {
      name: 'question',
      type: type,
      message: prompt,
      validate: (value) => {
        if (value.length) {
          return true;
        } else {
          return prompt
        }
      }
    },
  ];
  return inquirer.prompt(questions);
}

function askPassword(prompt) {
  const questions = [
    {
      name: 'password',
      type: 'password',
      message: prompt,
      validate: function(value) {
        if (value.length) {
          return true;
        } else {
          return 'Please enter your password.';
        }
      }
    },
  ];
  return inquirer.prompt(questions);
}

program.version('0.1.0');
program
  .command('list <dbpath>')
  .alias('l')
  .description('list the entries in the specified database file')
  .option('-g --group <group>', 'The group to search in')
  .option('-t --title <title>', 'The title of the entry to list')
  .option('-a --all', 'List all entries', false)
  .action(async (dbpath, options) => {
    let password = await askPassword();
    let credentials = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(password.password));
    const data = new Uint8Array(fs.readFileSync(dbpath));
    kdbxweb.Kdbx.load(data.buffer, credentials)
      .then(db => {
        // TODO: Refactor this ugly ass code, there's surely a cleaner way to filter
        // the groups and entries...

        db.groups[0].forEach((entry, group) =>{
          let groupname;
          if (!options.group && group) {
            groupname = group.name;
          } else {
            groupname = options.group; 
          }
          if (group && groupname === group.name) {
            console.log(
              chalk.yellow.bold(group.name)
            );
          }

          let entrytitle;
          if (!options.title && entry) {
            entrytitle = entry.fields.Title;
          } else {
            entrytitle = options.title;
          }
          if (entry && !options.group) {
            groupname = entry.parentGroup.name;
          }
          if (entry && entrytitle === entry.fields.Title && entry.parentGroup.name === groupname) { 
            console.log(
              listEntry(entry, 'lightblue')
            );
          } 
        });
      })
      .catch(err => console.log(err));
  });

program
  .command('pull <s3path>')
  .alias('p')
  .description('pull a database from s3 using a s3 url e.g. s3://my-bucket/k2/dbname')
  .action(async (s3path, options) => {
    pullS3(s3path)
      .then(res => {
        const [dbData, configData] = res;
        const dbname = s3path.split('/').pop();
        const config = new ConfigStore(
          `${PKG_NAME}-${dbname}`,
          JSON.parse(kdbxweb.ByteUtils.bytesToString(configData.Body))
        );
      })
      .catch(err => console.log(err));
  });

program
  .command('sync <dbpath>')
  .alias('s')
  .description('manually push a db file to it\'s configured S3 bucket')
  .option('-s --bucket <bucket>', 'override the configured S3 url with the one supplied to this flag - s3://bucket-name')
  .action(async (dbpath, options) => {
    const dbname = dbpath.split('/').pop();
    const config = new ConfigStore(`${PKG_NAME}-${dbname}`);
    const db = fs.readFileSync(dbpath);
    syncS3(db, config)
      .then(res => {
        const [dbUploadRes, configUploadRes] = res;
        console.log(
          `${dbpath} ${chalk.green('successfully')} synced to ${chalk.cyan(config.get('syncBucket'))}!\n` +
          `db upload version: ${chalk.cyan(dbUploadRes.VersionId)}\n` +
          `config upload version: ${chalk.cyan(configUploadRes.VersionId)}`
        ); 
      })
      .catch(err => {
        console.log(
          chalk.red(err)
        ); 
      });
  })

program
  .command('add <dbpath>')
  .alias('a')
  .description('add a new entry to the database with an autogenerated password')
  .option('-g --group <groupname>', 'The group to add the entry to', 'default')
  .option('-t --title <title>', 'The title of the entry')
  .option('-u --user <username>', 'The username of the entry')
  .option('--url <url>', 'The URL of the entry')
  .option('-n --note <note>', 'A note for the entry')
  .option('-a --askpass', 'If supplied the user will be prompted for a password, otherwise a random one is generated', false)
  .action(async (dbpath, options) => {
    let dbname = dbpath.split('/').pop();
    let config = new ConfigStore(`${PKG_NAME}-${dbname}`);
    let password = await askPassword('Enter the database password:');
    let credentals = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(password.password));
    // load the db
    console.log(
      chalk.yellow('Opening db...')
    );
    const data = new Uint8Array(fs.readFileSync(dbpath));
    let dbPromise = kdbxweb.Kdbx.load(data.buffer, credentals);
    dbPromise
      .then(async db => {
        let password;
        console.log(
          chalk.green('Successfully opened db!')
        );
        if (options.askpass) {
          let _password = await askPassword('Enter a password for the entry:');
          password = _password.password;
        } else {
          password = getRandomPass();
        }
        password = kdbxweb.ProtectedValue.fromString(password);
        let group;
        if (options.group && options.group !== 'default') {
          // does the group already exist in the db?
          // if so we just get it
          db.groups[0].forEach((entry, _group) => {
            if (_group && _group.name === options.group) {
              group = _group;
            }
          });
          // the group didn't exist in the db so we create it
          if (!group) {
            group = db.createGroup(db.getDefaultGroup(), options.group);
          }
        } else {
          group = db.getDefaultGroup();
        }
        let entry = db.createEntry(group);
        entry.fields.Title = options.title;
        entry.fields.UserName = options.user;
        entry.fields.URL = options.url;
        entry.fields.Password = password;
        entry.fields.Notes = options.note;
        console.log(
          chalk.yellow('entry added...')
        );
        console.log(
          listEntry(entry, 'lightblue')
        );
        console.log(
          chalk.yellow('saving DB...')
        );
        db.save()
          .then(db => {
            fs.writeFileSync(dbpath, Buffer.from(db));
            console.log(chalk.green('DB saved!'))
            // if the config contains a syncBucket path then try to sync the DB to the bucket
            syncS3(db, config);
          });
      })
      .catch(err => {
        console.log(
          chalk.red(err)
        );
      });
  });

program
  .command('newdb <dbpath>')
  .alias('n')
  .description('create a new database file')
  .option('-s --bucket <bucket>', 'The s3 url to sync the database and config to', '')
  .action(async (dbpath, options) => {
    let dbname = dbpath.split('/').pop();
    let config = new ConfigStore(`${PKG_NAME}-${dbname}`, {
      path: dbpath,
      name: dbname,
      syncBucket: options.bucket,
    });
    console.log(
      chalk.yellow(`config file: ${config.path}`)
    );
    console.log(
      chalk.yellow('initializing DB')
    );

    let password = await askPassword();
    let credentials = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(password.password));
    let newDb = kdbxweb.Kdbx.create(credentials, dbname);
    // write the database file out.
    newDb.upgrade();
    newDb.save()
      .then(db => {
        fs.writeFileSync(dbpath, Buffer.from(db));
        console.log(
          chalk.green(`${dbpath} created successfully!`)
        );
      })
      .catch(err => {
        console.log(
          chalk.red(err)
        );
      });
    console.log('');
  });

async function main() {
  console.log(
    chalk.green(
      figlet.textSync('k2', { horizontalLayout: 'full' })
    )
  );
  program.parseAsync(process.argv);
}
main();

