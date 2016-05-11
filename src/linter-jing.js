
import { CompositeDisposable } from 'atom';

let path;
let sax;
let helpers;
let subscriptions;

const localConfig = {};

const classPathDelimiter = process.platform === 'win32' ? ';' : ':';
const messageRegex = /^((.*?):\s?)?((\d+):)?((\d+):\s)?((error|fatal|warning):\s)(.*)$/;
const jars = {
  jing: '../vendor/jing/jing.jar',
  saxon: '../vendor/saxon/saxon9he.jar',
  xerces: '../vendor/xerces/xercesImpl.jar',
};

const parseMessage = (textEditor, schema) => function(str) {
  if (!helpers) helpers = require('atom-linter');

  const match = messageRegex.exec(str);
  if (!match) {
    console.log(`Could not parse message "${str}"`); // eslint-disable-line
    return null;
  }

  const [,, systemId,, line,, ,, level, text] = match;

  const filePath = textEditor.getPath();

  if (systemId !== filePath && level === 'warning' && !localConfig.displaySchemaWarnings) {
    return null;
  }

  const effectiveLine = systemId === filePath
    ? Number(line) - 1
    : schema.line;

  return {
    type: level === 'warning' ? 'Warning' : 'Error',
    html: `${text}`,
    filePath,
    range: helpers.rangeFromLineNumber(textEditor, effectiveLine),
  };
};

function getJars(lang) {
  switch (lang) {
    case 'xsd':
      return [jars.xerces, jars.jing];
    case 'sch.15':
    case 'sch.iso':
      return [jars.saxon, jars.jing];
    default:
      return [jars.jing];
  }
}

function runJing(textEditor, schema) {
  if (!path) path = require('path');
  if (!helpers) helpers = require('atom-linter');

  const xmlPath = textEditor.getPath();
  const params = [
    '-cp',
    getJars(schema.lang)
      .map(jar => path.resolve(__dirname, jar))
      .join(classPathDelimiter),
    'com.thaiopensource.relaxng.util.Driver',
    '-S',
    ...schema.lang === 'rnc' ? ['-c'] : [],
    schema.path || '-',
    xmlPath,
  ];

  const options = {
    cwd: path.dirname(xmlPath),
    stdin: textEditor.getText(),
    stream: 'stdout',
    ignoreExitCode: true,
  };

  return helpers
    .exec(localConfig.javaExecutablePath, params, options)
    .then(stdout =>
      stdout
        .split(/\r?\n/)
        .map(parseMessage(textEditor, schema))
        .reduce(
          (result, current) => (current ? result.concat(current) : result),
          []
        )
    );
}

function validateAll({ textEditor, schemata, messages }) {
  return Promise
    .all(schemata.map(schema => runJing(textEditor, schema)))
    .then(validatorMessages =>
      validatorMessages.reduce(
        (result, current) => result.concat(current),
        messages
      )
    );
}

function getPseudoAtts(body) {
  const pseudoAtts = {};
  body.replace(/(\w+)="(.+?)"/g, (unused, key, value) => (pseudoAtts[key] = value));
  return pseudoAtts;
}

function getXsiNamespacePrefixes(attributes) {
  const prefixes = [];
  Object
    .keys(attributes)
    .forEach(key => {
      const match = key.match(/xmlns:(.*)/);
      if (match && attributes[key] === 'http://www.w3.org/2001/XMLSchema-instance') {
        prefixes.push(match[1]);
      }
    });
  return prefixes;
}

function getSchemaRefs(textEditor) {
  if (!path) path = require('path');
  if (!sax) sax = require('sax');
  if (!helpers) helpers = require('atom-linter');

  return new Promise(resolve => {
    const messages = [];
    const schemata = [];
    const saxParser = sax.parser(true);

    let done = false;

    const onProcessingInstruction = node => {
      if (node.name !== 'xml-model') return;

      const { href, type, schematypens } = getPseudoAtts(node.body);

      let lang;
      if (href) {
        if (type === 'application/relax-ng-compact-syntax') {
          lang = 'rnc';
        } else if (schematypens === 'http://relaxng.org/ns/structure/1.0') {
          lang = path.extname(href) === '.rnc' ? 'rnc' : 'rng';
        } else if (schematypens === 'http://purl.oclc.org/dsdl/schematron') {
          lang = 'sch.iso';
        } else if (schematypens === 'http://www.ascc.net/xml/schematron') {
          lang = 'sch.15';
        } else if (schematypens === 'http://www.w3.org/2001/XMLSchema') {
          lang = 'xsd';
        } else {
          messages.push({
            type: 'Warning',
            html: 'Unknown schema type',
            filePath: textEditor.getPath(),
            range: helpers.rangeFromLineNumber(textEditor, saxParser.line),
          });
        }
      }

      if (lang) {
        schemata.push({
          lang,
          line: saxParser.line,
          path: href,
        });
      }
    };

    const onOpenTag = node => {
      if (done) return;

      const schemaLocations = [];

      getXsiNamespacePrefixes(node.attributes)
        .forEach(prefix => {
          const noNamespaceSchemaLocation = node.attributes[prefix + ':noNamespaceSchemaLocation'];
          if (noNamespaceSchemaLocation) {
            noNamespaceSchemaLocation
              .split(/\s+/)
              .forEach(schema => schemaLocations.push(schema));
          }

          const schemaLocation = node.attributes[prefix + ':schemaLocation'];
          if (schemaLocation) {
            schemaLocation
              .split(/\s+/)
              .filter((unused, index) => index % 2)
              .forEach(schema => schemaLocations.push(schema));
          }
        });

      const xsdSchemata = schemaLocations.map(schemaLocation => ({
        lang: 'xsd',
        line: saxParser.line,
        path: schemaLocation,
      }));

      schemata.push(...xsdSchemata);

      done = true;
    };

    saxParser.onerror = () => (done = true);
    saxParser.onprocessinginstruction = onProcessingInstruction;
    saxParser.onopentag = onOpenTag;

    const textBuffer = textEditor.getBuffer();
    const lineCount = textBuffer.getLineCount();
    const chunkSize = 64;
    let row = 0;

    while (!done && row < lineCount) {
      const line = textBuffer.lineForRow(row);
      const lineLength = line.length;
      let column = 0;
      while (!done && column < lineLength) {
        saxParser.write(line.substr(column, chunkSize));
        column += chunkSize;
      }
      if (!done) saxParser.write(textBuffer.lineEndingForRow(row));
      row++;
    }

    if (!schemata.length) {
      schemata.push({});
    }

    resolve({ textEditor, schemata, messages });
  });
}

module.exports = {
  config: {
    javaExecutablePath: {
      order: 1,
      type: 'string',
      default: 'java',
    },
    displaySchemaWarnings: {
      order: 2,
      type: 'boolean',
      default: false,
    },
  },

  activate() {
    require('atom-package-deps').install();
    subscriptions = new CompositeDisposable();

    Object
      .keys(this.config)
      .forEach(key =>
        subscriptions.add(
          atom.config.observe(
            `linter-jing.${key}`,
            value => (localConfig[key] = value)
          )
        )
      );
  },

  deactivate() {
    subscriptions.dispose();
  },

  provideLinter() {
    return {
      name: 'Jing',
      grammarScopes: ['text.xml', 'text.xml.plist', 'text.xml.xsl', 'text.mei'],
      scope: 'file',
      lintOnFly: true,
      lint: textEditor => getSchemaRefs(textEditor).then(validateAll),
    };
  },
};
