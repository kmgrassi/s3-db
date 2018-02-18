const argv = require('yargs').argv;
const states = require('./modules/states');
const Promise = require('bluebird');
const request = require('requestretry');
const rp = require('request-promise');
const fs = require('fs');
const unzip = require('unzip');
const csv = require('csvtojson');
const rimraf = require('rimraf');
const AWS = require('aws-sdk');
const path = require('path');
const Papa = require('papaparse');
const dataset = require('./modules/settings.js').dataset;
const geography_file_headers = require('./modules/settings.js').geography_file_headers;


if (argv._.length === 0) {
  console.log('fatal error.  Run like: node mparse.js 2015');
  process.exit();
}

const YEAR = argv._[0];


readyWorkspace()
  .then(() => {
    return downloadDataFromACS();
  })
  .then(() => {
    console.log('downloading schemas, geoids, and cluster information');
    return Promise.all([createSchemaFiles(), getGeoKey(), getClusterInfo()]);
  })
  .then((setup_information) => {
    const schemas = setup_information[0];
    const keyed_lookup = setup_information[1];
    const cluster_lookup = setup_information[2];
    console.log('parsing ACS data');
    return parseData(schemas, keyed_lookup, cluster_lookup);
  })
  .then(() => {
    console.log('done');
  });




/****************/

function parseData(schemas, keyed_lookup, cluster_lookup) {

  // for file in directory

  fs.readdir(`./CensusDL/stage`, (err, files) => {
    if (err) {
      console.log('error: ', err);
      process.exit();
    }
    console.log(files);

    const parsed_files = files.map(file => {
      const e_or_m = file.slice(0, 1);

      return new Promise((resolve, reject) => {
        const data_cache = {};

        // TODO Need to provide data here rather than a file path

        Papa.parse(path.join(__dirname, 'CensusDL/stage/', file), {
          header: false,
          skipEmptyLines: true,
          complete: function() {

            let put_object_array = [];
            const file_state = file.slice(8, 10);

            Object.keys(data_cache).forEach(attr => {
              Object.keys(data_cache[attr]).forEach(sumlev => {
                Object.keys(data_cache[attr][sumlev]).forEach(cluster => {
                  // write to directory, sync to S3 later

                  const filename = `./CensusDL/output/${attr}-${sumlev}-${cluster}_!${file_state}.json`;
                  const data = JSON.stringify(data_cache[attr][sumlev][cluster]);

                  const promise = new Promise((resolve, reject) => {

                    fs.writeFile(filename, data, 'utf8', function(err) {
                      if (err) {
                        return reject(err);
                      }
                      resolve('done');
                    });
                  });

                  put_object_array.push(promise);
                });
              });
            });

            // after all files (attributes) saved to directory, move on to next file
            Promise.all(put_object_array).then(d => {
              console.log(`saved: ${d.length} files into staging directory`);
              resolve(`finished: ${file}`);
            }).catch(err => {
              reject(err);
            });

          },
          step: function(results) {

            if (results.errors.length) {
              console.log(results);
              console.log('E: ', results.errors);
              reject(results.errors);
              process.exit();
            }

            const seq_string = file.split('.')[0].slice(-6, -3);
            const seq_fields = schemas[seq_string];

            // combine with geo on stustab(2)+logrecno(5)
            const unique_key = results.data[0][2] + results.data[0][5];
            const geo_record = keyed_lookup[unique_key];

            // only tracts, bg, county, place, state right now
            const sumlev = geo_record.slice(0, 3);

            const component = geo_record.slice(3, 5);
            if (sumlev !== '140' && sumlev !== '150' && sumlev !== '050' && sumlev !== '160' && sumlev !== '040') {
              return;
            }
            if (component !== '00') {
              return;
            }

            const geoid = geo_record.split('US')[1];

            let parsed_geoid = "";

            if (sumlev === '040') {
              parsed_geoid = geoid.slice(-2);
            }
            else if (sumlev === '050') {
              parsed_geoid = geoid.slice(-5);
            }
            else if (sumlev === '140') {
              parsed_geoid = geoid.slice(-11);
            }
            else if (sumlev === '150') {
              parsed_geoid = geoid.slice(-12);
            }
            else if (sumlev === '160') {
              parsed_geoid = geoid.slice(-7);
            }
            else {
              console.error('unknown geography');
              console.log(geoid);
              console.log(sumlev);
              process.exit();
            }

            const cluster = cluster_lookup[parsed_geoid];

            // some geographies are in the census, but not in the geography file.
            // we will keep ignore these
            if (cluster === undefined) {
              return;
            }

            results.data[0].forEach((d, i) => {

              if (i <= 5) {
                // index > 5 excludes: FILEID, FILETYPE, STUSAB, CHARITER, SEQUENCE, LOGRECNO
                return;
              }

              const attr = (e_or_m === 'm') ? seq_fields[i] + '_moe' : seq_fields[i];

              if (!data_cache[attr]) {
                data_cache[attr] = {};
              }

              if (!data_cache[attr][sumlev]) {
                data_cache[attr][sumlev] = {};
              }

              if (!data_cache[attr][sumlev][cluster]) {
                data_cache[attr][sumlev][cluster] = {};
              }

              const num_key = (d === '' || d === '.') ? null : Number(d);

              // this is how the data will be modeled in S3
              data_cache[attr][sumlev][cluster][parsed_geoid] = num_key;


            });

          }
        });
      });

    });

    return Promise.all(parsed_files);

  });

}



function getClusterInfo() {

  // Load cluster files for each geographic level;

  const promises = ['bg', 'tract', 'place', 'county', 'state'].map(geo => {
    return rp({
      method: 'get',
      uri: `https://s3-us-west-2.amazonaws.com/${dataset[YEAR].cluster_bucket}/clusters_${dataset[YEAR].year}_${geo}.json`,
      headers: {
        'Accept-Encoding': 'gzip',
      },
      gzip: true,
      json: true,
      fullResponse: false
    });
  });

  return Promise.all(promises)
    .then(data => {

      const arr = data.map(d => {
        return d[dataset[YEAR].clusters];
      });

      // parse into one master object with all geoids
      return Object.assign({}, ...arr);

    });

}


function getGeoKey() {

  return rp({
    method: 'get',
    uri: `https://s3-us-west-2.amazonaws.com/s3db-acs-${dataset[YEAR].text}/g${YEAR}.json`,
    json: true,
    fullResponse: false
  });

}



function createSchemaFiles() {
  return new Promise((resolve, reject) => {

    const url = `https://www2.census.gov/programs-surveys/acs/summary_file/${YEAR}/documentation/user_tools/ACS_5yr_Seq_Table_Number_Lookup.txt`;
    request(url, function(err, resp, body) {
      if (err) { return reject(err); }

      csv({ noheader: false })
        .fromString(body)
        .on('end_parsed', data => {

          const fields = {};
          // filter out line number if non-integer value
          data.forEach(d => {
            const line_number = Number(d['Line Number']);
            if (Number.isInteger(line_number) && line_number > 0) {
              const field_name = d['Table ID'] + String(d['Line Number']).padStart(3, "0");
              const seq_num = d['Sequence Number'].slice(1);
              if (fields[seq_num]) {
                fields[seq_num].push(field_name);
              }
              else {
                fields[seq_num] = ["FILEID", "FILETYPE", "STUSAB", "CHARITER", "SEQUENCE", "LOGRECNO", field_name];
              }
            }
          });

          fs.writeFileSync('./CensusDL/geofile/schemas.json', JSON.stringify(fields), 'utf8');
          resolve(true);
        })
        .on('done', () => {
          //parsing finished
          console.log('finished parsing schema file');
        });
    });
  });
}

function downloadDataFromACS() {
  const isTractBGFile = true;
  const fileType = isTractBGFile ? 'Tracts_Block_Groups_Only' : 'All_Geographies_Not_Tracts_Block_Groups';
  const outputDir = 'CensusDL/group/';
  const seq_num = '001';
  // todo ? 1 year files?

  const states_data_ready = Object.keys(states).slice(0, 2).map((state, index) => {
    const fileName = `${YEAR}5${state}0${seq_num}000.zip`;
    const url = `https://www2.census.gov/programs-surveys/acs/summary_file/${YEAR}/data/5_year_seq_by_state/${states[state]}/${fileType}/${fileName}`;

    return new Promise((resolve, reject) => {
      request({ url, encoding: null }, function(err, resp, body) {
        if (err) { return reject(err); }
        fs.writeFile(`${outputDir}${fileName}`, body, function(err) {
          if (err) { return reject(err); }
          console.log(`${fileName} written!`);

          // unzip
          const stream = fs.createReadStream(`${outputDir}${fileName}`);
          stream.pipe(unzip.Extract({ path: `CensusDL/stage` })
            .on('close', function() {
              console.log(`${fileName} unzipped!`);
              resolve('done unzip');
            })
            .on('error', function(err) {
              reject(err);
            })
          );
        });
      });

    });
  });

  return Promise.all(states_data_ready);
}


function readyWorkspace() {
  return new Promise((resolve, reject) => {
    // delete ./CensusDL if exists
    rimraf('./CensusDL', function(err) {
      if (err) {
        return reject(err);
      }

      // logic to set up directories
      const directories_in_order = ['./CensusDL', './CensusDL/group', './CensusDL/stage',
        './CensusDL/ready', './CensusDL/geofile', './CensusDL/output'
      ];

      directories_in_order.forEach(dir => {
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir);
        }
      });

      console.log('workspace ready');
      resolve('done');
    });
  });
}