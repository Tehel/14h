const fs = require('fs').promises;

// https://www.npmjs.com/package/midi-parser-js
// const MidiParser = require('./node_modules/midi-parser-js/src/midi-parser.js');
// async function main() {
// 	const fileData = await fs.readFile('midi/Movie_Themes_-_1492_Conquest_of_Paradise.mid');
// 	const midiData = MidiParser.parse(fileData);
// 	console.log(JSON.stringify(midiData, null, 4));
// }
// main();
// return;

// async function main() {
// 	try {
// 		const MidiParser = require('midi-file-parser');
// 		const file = await fs.readFile('midi/Unknown_-_pokemon.mid', 'binary');
// 		console.log(file.length);
// 		const midi = MidiParser(file);
// 		console.log(JSON.stringify(midi, null, 4));
// 	} catch(err) {
// 		console.log(`Error: ${err}`);
// 	}
// }
// main();
// return;


async function browseDir(path, filter) {

	const entries = await fs.readdir(path);
	for (const entry of entries) {
		if (!entry.endsWith('.mid'))
			continue;
		if (filter && !filter.test(entry))
			continue;
		const filepath = `${path}/${entry}`;
		const stat = await fs.stat(filepath);
		if (!stat.isFile())
			continue;
		console.log("\nReading file " + filepath);

		try {
			const mid = await readFile(filepath);
			await fs.writeFile(filepath + '.json', JSON.stringify(mid, null, 4), 'utf8');
		} catch(error) {
			console.log(error);
		}
	}
}

async function readFile(filepath) {

	const buff = await fs.readFile(filepath);
	// list chunks
	const mid = {
		format: null,
		trackNb: null,
		tracks: [],
	}

	let offset = 0;
	while (offset < buff.length) {
		if (buff.length < offset + 8) {
			console.log("incomplete header !");
			break;
		}
		const id = buff.slice(offset, offset + 4).toString();
		const chunkLength = buff.readUInt32BE(offset + 4);
		const data = buff.slice(offset + 8, offset + chunkLength + 8);

		if (id === 'MThd') {
			// header
			mid.format = data.readUInt16BE(0);
			mid.trackNb = data.readUInt16BE(2);
			const timeDiv = data.readUInt16BE(4);
			if (timeDiv & 0x8000) {
				// frames per second
				mid.framePerSecond = (timeDiv >> 8) & 0x7f;
				mid.ticksPerFrame = timeDiv & 0xff;
			} else {
				// ticks per bit
				mid.ticksPerBeat = timeDiv;
			}
		} else if (id === 'MTrk'){
			if (data.length !== chunkLength) {
				console.log("truncated track !");
				break;
			}
			console.log(`\tTrack at offset: 0x${offset.toString(16)}, length: 0x${chunkLength.toString(16)}`);
			// decode events
			mid.tracks.push(readEvents(data));
		} else if (id === '\0\0\0\0') {
			console.log("chunk id is null, exiting");
			break;
		} else {
			console.log(`unknown chunk type: ${id}, skipped`);
		}

		offset += chunkLength + 8;
	}
	if (offset !== buff.length) {
		console.log("file not ok");
		return null;
	}

	return mid;
}

function readEvents(buffer) {

	const midiTypes = {
		0x8: { name: "note off", paramB1: "noteNumber", paramB2: "velocity"},
		0x9: { name: "note on", paramB1: "noteNumber", paramB2: "velocity"},
		0xa: { name: "note aftertouch", paramB1: "noteNumber", paramB2: "amount"},
		0xb: { name: "controller", paramB1: "controllerType", paramB2: "value"},
		0xc: { name: "program change", paramB1: "programNumber"},
		0xd: { name: "channel aftertouch", paramB1: "amount"},
		0xe: { name: "pitch bend", param7x2LE: "pitch"},
	};
	const metaTypes = {
		0x0: { name: "Sequence number", paramW: "number"},
		0x1: { name: "Text", string: "text"},
		0x2: { name: "Copyright", string: "text"},
		0x3: { name: "Sequence/Track Name", string: "name"},
		0x4: { name: "Instrument Name", string: "instrument"},
		0x5: { name: "Lyrics", string: "text"},
		0x6: { name: "Marker", string: "text"},
		0x7: { name: "Cue point", string: "text"},
		0x8: { name: "Program name", string: "text"},
		0x9: { name: "Device name", string: "text"},
		0x20: { name: "MIDI Channel Prefix", paramB1: "channel"},
		0x21: { name: "MIDI Port Prefix", paramB1: "port"},
		0x2f: { name: "End of track"},
		0x51: { name: "Set tempo", param3B: "MsQuarter"},
		0x54: { name: "SMTPE offset", paramB1: "hours", paramB2: "minutes", paramB3: "seconds", paramB4: "frames", paramB5: "subframes"},
		0x58: { name: "Time signature", size: 4, paramB1: "numerator", paramB2: "denominator", paramB3: "metro", paramB4: "nd32"},
		0x59: { name: "Key signature", paramBS1: "key", paramB2: "scale"},
		0x7f: { name: "Sequencer specific", buff: "data"},
	};

	let offset = 0;
	let lastType = null;
	const events = [];
	while (offset < buffer.length) {
		// console.log(`readEvents loop:  length: ${buffer.length}, offset: ${offset}`);
		const event = {};
		[offset, event.deltaTime] = readVariable(buffer, offset);

		// read event type. If upper bit is 0, type is omitted, use the previous one
		let byteType = buffer.readUInt8(offset);
		if (byteType & 0x80) {
			lastType = byteType;
			offset += 1;
			// console.log(`new event type: ${byteType}`);
		} else {
			byteType = lastType;
			// console.log(`keeping last type: ${byteType}`);
		}

		const eventType = (byteType & 0xf0) >> 4;

		if (byteType === 0xff) {
			// Meta event
			event.metaType = buffer.readUInt8(offset);
			offset += 1;
			let dataLength = null;
			[offset, dataLength] = readVariable(buffer, offset);
			const data = buffer.slice(offset, offset + dataLength);

			const type = metaTypes[event.metaType];
			// console.log(`\t\tMeta event: at offset 0x${(offset-1).toString(16)}, type 0x${event.metaType.toString(16)} (${type.name})}, delta: ${event.deltaTime}`);
			if (type) {
				if (type.size && type.size !== dataLength) {
					console.log(`!! Bad size for meta event ${event.metaType}: expected ${type.size}, got ${dataLength}`)
					offset += dataLength;
					continue;
				}
				event.type = type.name;
				if (type.paramW)	event[type.paramW] = data.readUInt16BE(0);
				if (type.paramB1)	event[type.paramB1] = data.readUInt8(0);
				if (type.paramBS1)	event[type.paramBS1] = data.readInt8(0);
				if (type.paramB2)	event[type.paramB2] = data.readUInt8(1);
				if (type.paramB3)	event[type.paramB3] = data.readUInt8(2);
				if (type.paramB4)	event[type.paramB4] = data.readUInt8(3);
				if (type.paramB5)	event[type.paramB5] = data.readUInt8(4);
				if (type.param3B)	event[type.param3B] = (data.readUInt8(0) << 16) + (data.readUInt8(1) << 8) + data.readUInt8(2);
				if (type.string)	event[type.string] = data.toString();
				if (type.buff)		event[type.buff] = data.toString('hex');
			} else {
				console.log(`Unknown meta event type: 0x${event.metaType.toString(16)} at 0x${(offset-1).toString(16)}. Ignored.`);
				event.type = 'Unknown META';
				event.dataLength = dataLength;
				event.data = data.toString('hex');
			}
			offset += dataLength;
			events.push(event);
		} else if (eventType === 0xf) {
			// SysEx
			// console.log(`\t\tSysEx event: at offset 0x${(offset-1).toString(16)}, type 0x${byteType.toString(16)}, delta: ${event.deltaTime}`);
			let dataLength = null;
			[offset, dataLength] = readVariable(buffer, offset);
			event.type = 'SysEx';
			event.dataLength = dataLength;
			const data = buffer.slice(offset, offset + dataLength);
			event.data = data.toString('hex');
			event.dataStr = data.toString('utf8');
			offset += dataLength;
			events.push(event);
		} else {
			// Midi Channel event
			const type = midiTypes[eventType];
			if (!type) {
				throw new Error(`Unknown Midi event type: 0x${byteType.toString(16)}, at offset 0x${(offset - 1).toString(16)}`);
			}
			event.channel = byteType & 0x0f;
			event.type = type.name;
			// console.log(`\t\tMidi event: at offset 0x${(offset-1).toString(16)}, type 0x${byteType.toString(16)} (${event.type})}, delta: ${event.deltaTime}`);

			if (type.paramB1) {
				event[type.paramB1] = buffer.readUInt8(offset);
				offset += 1;
			}
			if (type.paramB2) {
				event[type.paramB2] = buffer.readUInt8(offset);
				offset += 1;
			}
			if (type.param7x2LE) {
				event[type.param7x2LE] = (buffer.readUInt8(offset) & 0x7f) + (buffer.readUInt8(offset+1) & 0x7f) << 7;
				offset += 2;
			}
			events.push(event);
		}
	}
	return events;
}

function readVariable(buffer, offset) {

	let onemore = true;
	let value = 0;
	while (onemore) {
		const byte = buffer.readUInt8(offset);
		offset += 1;
		onemore = (byte & 0x80) !== 0;
		value = (value << 7) + (byte & 0x7f);
	}
	return [offset, value];
}

// browseDir('midi', /Pink/);
browseDir('midi');
