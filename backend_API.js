/*
                         __  __        _____
                        |  \/  |      / ____|  /\
                        | \  / |_   _| (___   /  \
                        | |\/| | | | |\___ \ / /\ \
                        | |  | | |_| |____) / ____ \
                        |_|  |_|\__,_|_____/_/    \_\


    @author f.invernizzi@libero.it



* This is a mongoDB frontend.
* API automatic generation starting from schemas.
* Schemas are expected to be in ./schemas.js 
*
* Mongoose doc:
* DOC: https://pixelhandler.com/posts/develop-a-restful-api-using-nodejs-with-express-and-mongoose
*
* This serves 
*	- the backend API
*
* DEVELOPMENT vs PRODUCTION
* To better armonize with other services, the choice is done from the ENV variable MUSA_RUN_MODE
*
*  ^^^  MAPS (container)   ^^^
*   Sono una modalià per associare piu oggetti ad un identificativo unico. Utile, ad esempio, per le lingue
*  	Tutte le operazioni rimangono invariate.s
* 	Per avere l'elenco dei contenuti associati, il READ (GET) viene definito un filtro dedicato (map).
*   Tutte le altre operazioni: vengono effettuate (se necessario) anche alla mappa nel caso l body contenga il campo _maps_to_ : <MAP_ID>
* 	Tutti i documenti hanno un _maps_to_ nello schema per semplificare la gestione delle mappe.
* 	In tutte le operazioni di modifica sui documenti valorizzare _maps_to_ a
*	- if is one of defined mapType (es "lang") create a new map and insert the document
*   - if is a valid id of a map, find the map corresponding to that id and checks on that 
*   - in all other case no operations on maps are performed
*
* ^^^   ^^^^   ^^^
* 
* authentication 
* 			- authorizedOnly: plain text in credentials.js and statefull
* @FIXME: Al momento funziona solo con un elemento nell'array del document _maps_to_
* @FIXME: In alcuni casi, come ad esempio schema non valido, non gestisce correttamente errori (invia res.send dopo il gestore degli errori di express che lo ha gia inviato)
*
*
*	06022016 - Creation of documents with map creation implemented. WORKS ONLY if the document is only in one map
*   07022016 - Creation of documents completed. Some bugs resolved in map management. Test implemented
*	19022916 - Read ENV var to see the run mode
* 				Token based auth
*   20022016 - Update a doc now works (with tests) on maps update. If a map already has the lang, it rises an error
*   22022016 - Delete completed.
*   03032016 - token auth for delete method
*/


/*
* Configurations
*/
"use strict";

var express = require('express'),
	bodyParser = require('body-parser'),
	methodOverride = require('method-override'),
	mongoose = require('mongoose'),
	colors = require('colors/safe'), // Coloured cli
	errorhandler = null,
	path = require("path"),
	routes = require('./routes/index'),
	_ = require('lodash'),
	config = require('./config.js'),
	credentials = require('./credentials.js'),
	tokens = require('./tokens.js'), // Token based authentication
	session = require('express-session');
	
var __DATABASE_NAME__ = config.__DATABASE_NAME__;
var __DATABASE_HOST__ = config.__DATABASE_HOST__;
// Port we should listen on
var __LISTEN_PORT__ = config.__LISTEN_PORT__;
var LOG_FILE = config.LOG_FILE;
var STATIC_CONTENT_DIR = config.STATIC_CONTENT_DIR;

/** Just a better name for the process **/
process.name = "API backend server";

/*
* Here schemas and schema names are defined
*/
var Schema = mongoose.Schema;
var schemas = {};
// Here we store all models
var models = {};
// Available models. To avoid looking in models each time
var knownModels = [];
// Available maps
var availableMaps = [];
// Populates our internal schema and models
require('./schemas.js').Schemas.forEach(function(sch , index){
	models[sch.name] = mongoose.model(sch.name, sch.schema);
	schemas[sch.name] = sch.schema;
	knownModels.push(sch.name);
	
});
var availableMaps = require('./schemas.js').__available_maps__;
var schemaVersion = require('./schemas.js').Version.toLowerCase();


var app = express();
// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'hbs');

/***************************/
// DEVELOPMENT - PRODUCTION
// This changes also where libraries are loaded from
if (process.env.MUSA_RUN_MODE)
	app.set('env' , process.env.MUSA_RUN_MODE)
else
	app.set('env' ,"production");
switch(app.get('env')){
    case 'development':
    	console.log(colors.red("WORKING IN DEVELOPMENT MODE"));
        console.log(colors.red("Static content dir:"+STATIC_CONTENT_DIR+"\n"));
        app.use(require('morgan')('dev'));
        errorhandler = require('errorhandler'); // DEVELOPMENT only error handling
        break;
    case 'production':
        app.use(require('express-logger')({
            path: LOG_FILE
        }));
        break;
}
/******************************/
 

/*********************************
* 		sessions				 *
/*********************************/
 app.use(session({
  secret: credentials.cookieSecret,
  resave: true,
  saveUninitialized: true,
  rolling : true
}));


app.use(express.static(path.join(__dirname, STATIC_CONTENT_DIR)));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({     // to support URL-encoded bodies
  extended: true
})); 
//@TODO: al momento non lo uso. Serve per browser che non supportano put e delete
app.use(methodOverride());

/*********************************
* 		mongo connection		 *
/*********************************/
var options = {
	server: { poolSize: 5 },
  	replset: { rs_name: 'myReplicaSetName' }
};
// keep alive
options.server.socketOptions = options.replset.socketOptions = { keepAlive: 120 };

mongoose.connect('mongodb://'+__DATABASE_HOST__+'/'+__DATABASE_NAME__, options);



/**********************************************
*			ROUTES							  *
* Actions are identified by the type of query *
* 										      *
/*********************************************/
var router = express.Router();
app.use(router);

// Checks if we know the model and the correct version
app.all('/api/:version/:model' , function(req,res,next){
	if (!isKnownModel(req.params.model) ){
		return res.status(400).send('Unknown model '+req.params.model);
	}
	if (schemaVersion != req.params.version.toLowerCase())
		return res.status(400).send('Unsupported version '+req.params.version);
	next();
});

/**************************
* 		FIND
* This will accept 
*	- /api/version/{model} : returns all the documents associated with {model}
*	- /api/version/{model}/{filter_type}/{filter}: returns all documents of {model}, matching the specified filter. Supported filters
*		. /api/version/{model}/id/{id} returns all documents of model with the specified id
*		. /api/version/{model}/key/{val} returns all documents with key=val.
*		. /api/version/{model}/map/{map_type}/{map_filter}. Gives documents id of {model} contained in the map {map_type} where map ID is {map_filter.}
*			Example:   http://127.0.0.1:3003/api/v1/Contents/map/lang/it/56b23ae7f33616d2df6f64df - looks for a map of Contents for language it (ID of the MAP!)
*		. /api/version/{model}/map/{map_type}/{map_filter}/{modifier}.  As previous but modifier can change the result. Defined modifiers
*			- document instead of id of {model}, gives the model
*		
**************************/
app.get(['/api/:version/:model/:filter_type/:key/:val' ,
		 '/api/:version/:model/:filter_type/:key/:val/:filter' , /* Example: http://127.0.0.1:3003/api/v1/Contents/map/lang/it/56b23ae7f33616d2df6f64df */
		 '/api/:version/:model/:filter_type/:key/:val/:filter/:modifier' , 
		 '/api/:version/:model/:filter_type/:filter' , 
		 '/api/:version/:model' ] ,  function(req,res){ find(req,res); });

/**************************
* 		CREATE
**************************/
app.post('/api/:version/:model', authorizedOnly , function (req, res) { create(req,res); });

/**************************
* 		UPDATE
**************************/
app.put('/api/:version/:model/:id', authorizedOnly , function (req, res) { update(req , res); });

/**************************
* 		DELETE
**************************/
app.delete(['/api/:version/:model/:id/:token', 
			'/api/:version/:model/:id'],
	authorizedOnly , function (req, res) { remove(req , res); });

/**************************
* 	  AUTHENTICATION
**************************/
app.post('/signIn' , signIn);
app.post('/signOut' , signOut);

/**************************
*  --- Default route ---
**************************/
app.use('/', routes);

app.listen(__LISTEN_PORT__, function () {
  console.log(colors.green.underline('--- API server listening on port '+__LISTEN_PORT__));
});


/************************
*
*	 MONGO functions	
*
*************************/

/*
* FIND 
*/
function find(req , res){
	var model = getModel(req.params.model);
	// Filter defined in query
	if (req.params.filter_type){
		switch (req.params.filter_type){
			case "id":
				if (!req.params.filter || (req.params.filter == "undefined")){
					res.status(400).send({request:"find" , status:-1 , err:new Error("Malformed url. Missing paramenter")});
					return logToConsole("Malformed url. Missing paramenter");
				}
				model.findById(req.params.filter, function (err, found) {
					if (!err) {
						return res.send({request:"find" , status:1 , found:found});
					} else {
						res.status(500).send({request:"find" , status:-1 , err:err});
						return logToConsole(err);
					}
				});
				break;
			case "key":
				if (!req.params.key || !req.params.val){
					res.status(400).send({request:"find" , status:-1 , err:new Error('Malformed url. Missing parameters')});
					return;
				}
				var key =req.params.key.escape, val =req.params.val.escape;
				//var k =req.params.key, v =req.params.val;
				//var type = "'"+k+"'";
				//model.find( {type:v}, function (err, found) {
				model.find( {key:val}, function (err, found) {
					if (!err) {
						return res.send({request:"find" , status:1 , found:found});
					} else {
						res.status(400).send({request:"find" , status:-1 , err:err});
						return logToConsole(err);
					}
				});
				break;
			case "map":
				// Load the model of maps
				var mapModel = getModel('Maps');
				if (!req.params.model || !req.params.key || !req.params.val ){
					res.status(500).send({request:"find" , status:-1 , err:new Error('Missing parameter in map query')});
					return logToConsole(Error);
				}
				if (req.params.filter){
					mapModel.findById(req.params.filter, function (err, found) {
						if (!err) {
							var child = childFromMapByLanguage(found , req.params.val);
							if (child){
								// Return the document or the id?
								if (req.params.modifier == "document"){	
										model.findById(child.docID, function (err, found) {
										if (err || found == null) {
											err = err || new Error("Document not found from MAP id")
											res.status(400).send({request:"find" , status:-1 , err:err});
											return logToConsole(err);
										} else {
											return res.send({request:"find" , status:1 , found:found});
										}
									});
								}else{
									// We need to extract the lang from found document
									return res.send({request:"find" , status:1 , found:child});
								}
							}
							else
								return res.status(400).send({request:"find" , status:-1 , err:new Error('Child not found')});
						} else {
							res.status(500).send({request:"find" , status:-1 , err:err});
							return logToConsole(err);
						}
					});
				}
				break;
			default:
				res.status(400).send({request:"find" , status:-1 , err:new Error("Unsupported filter type:"+req.params.filter_type)});
				return false;				
		}
	}else{
		model.find(function (err, found) {
		if (!err) {
		  return res.send({request:"find" , status:1 , found:found});
		} else {
		  logToConsole(err)
		  res.status(500).send({request:"find" , status:-1, err:err});
		}
	  });
	}
	return true;
}

/*
* Create
* Using the params in the body request, create a new document
* Checks on maps are also performed
* @param  {[type]}
* @param  {[type]}
* @return {[type]}
*/
function create(req , res){
  /* For any defined param, set in the model
  * No specific control is done. Mongoose will arise errors in case
  */
  var pars = _.keys(req.body);
  var istanceOptions = {};
  pars.forEach(function(p , i){
  	istanceOptions[p] = req.body[p];
  });
  
  var model = getModel(req.params.model);
  //var istance = new model(istanceOptions);
  var mapModel = getModel('Maps');
  
  // First of all create the doc. 
  // This is needed to have the doc _id in case we have to modify a map
  var istance = new model(istanceOptions);
	istance.save(function (err , ret) {
		if (!err) {
		}else {
			console.log(err);
			res.status(500).send({request:"create" , status:-1, err:err}); 
			return false;
		}
	})
  // MAPS	
  // Should we also do something on a map?
  checkDocumentInMap(istance , req.params.model , istanceOptions.lang, function(err , ret){
  	if (err){
  		console.log(err);
		res.status(400).send({request:"create" , status:-1, err:err});
  	}else{
  		// If we have changed _maps_to_ we must save again the doc...
  		if (ret.__changed__){
  			ret.save(function (err , ret) {
				if (!err) {
					// @FIXME: potrei avere piu elementi nell'array  
					res.send({request:"create" , status:1 , _id:ret._id , map_id : ret._maps_to_[0]});
       				return true;
				}else {
					console.log(err);
					res.status(500).send({request:"create" , status:-1, err:err}); 
					return false;
				}
			})
  		}else{
  			res.send({request:"create" , status:1 , _id:ret._id });
       		return true;
  		}
  	}
  });
 
}

/*
* UPDATE
* Given an id and params in the body, update a document
*/
function update(req , res){
	var model = getModel(req.params.model);
	if (!req.params.id){
		return res.status(400).send({request:"update" , status:-1 , err:new Error("Missing id in update request")});
	}
	// Params to be updated
	var pars = _.keys(req.body);
	
	 model.findById(req.params.id, function (err, found) {
	 	if (!found)
	 		return res.status(400).send({request:"update" , status:-1 , err:new Error("Unknown documents "+req.params.id)});
		pars.forEach(function(p , i){
  			found[p] = req.body[p];
  		});
		found.save(function (err) {
			if (!err) {
				// MAPS
				// Should we update something in maps?
				checkDocumentInMap(found , req.params.model , found.lang, function(err , ret){
					if (err){
						logToConsole(err);
						return res.status(500).send({request:"update" , status:-1, err:err}); 
					}else{
						if (ret.__changed__){
							ret.save(function (err , ret) {
								if (!err) {
									// @FIXME: potrei avere piu elementi nell'array  
									return res.send({request:"update" , status:1 , _id:ret._id , map_id : ret._maps_to_[0]});
									return true;
								}else {
									logToConsole(err);
									return res.status(500).send({request:"update" , status:-1, err:err}); 
									return false;
								}
							})
						}else{
							return res.send({request:"update" , status:1});
						}
					}
				})
			} else {
				return res.status(500).send({request:"update" , status:-1, err:err}); 
			}
		});
	  });
}


/*
* DELETE
* Given an id of a document delete it
*/
function remove(req , res){
	var model = getModel(req.params.model);
	if (!req.params.id){
		return res.status(400).send({request:"delete" , status:-1 , err:new Error("Missing id in delete request")});
	}
	model.findById(req.params.id, function (err, found) {
	 if (!found){
	 	return res.status(400).send({request:"delete" , status:-1, err:new Error("Inexistent document")}); 
	 }else{
	 	found.remove(function (err) {
      		if (!err) {
      			// Should we remove from map?
      			if (found._maps_to_)
      			{
      				found._maps_to_.forEach(function(mapID , index){
      			      				removeDocumentFromMap(found._id , mapID , function(err , ret){
      			      						if (!err)
      			      							logToConsole('Removed doc '+found._id+' from '+ mapID)
      			      					/* No messages for the map remove... */
      			      				})
      			      	 }
      			      )}
       			return res.send({request:"delete" , status:1 , id:req.params.id});
      		} else {
        		return res.status(500).send({request:"delete" , status:-1, err:err}); 
      		} 
    	});
    }
  });
}


/*
*
* checkDocumentInMap
* Checks if document is already in a map mapType
* Operations change based upon value of content._maps_to_ (that is an array):
*	- if is one of defined mapType (es "lang") create a new map and insert the document
*   - if is a valid id, find the map corresponding to that id and checks on that 
*   - if is null, no operations on maps are performed
* @param document {Obj} the document to be checked
* @param documentSchemaName {String} the name of the schema (es. Content)
* @param mapValue {String} the name of the filter in map (es. 'it')
* @param callback {function} the function called at the end (err, MapID)
*
*/
function checkDocumentInMap(document , documentSchemaName , mapValue, callback){
	var mapModel = getModel('Maps');
	var newMaps = []; // we should collect the map ID
	
	// The map exists and we should check there
	if (document._maps_to_ && (document._maps_to_ != null) && document._maps_to_.length > 0){
			// _maps_to_ is an array of maps
			//@FIXME: questo non funziona perche i save sono asyncroni. Per adesso in pratica ipotizzo di avere un solo elemento in array.
			// DA SISTEMARE!
			document._maps_to_.forEach(function(maps,index){
				document.__changed__ = true; // this helps saving again only when needed
				// should we create a new map?
				if(isAMap(maps)){
						logToConsole("OK, a new MAP is required")
						var mapDetails = {};
						// Create the map istance
						mapDetails.type = maps;
						mapDetails.doc_schema = documentSchemaName;
						// It is new, so completely set the array
						mapDetails.children = [{value: mapValue/* es. it */ , docID: document._id}];
						var mapIstance = new mapModel(mapDetails);
						// Save the map
						mapIstance.save(function(map_err , map_ret){
							if (map_err){
								console.log("Error Creating the MAP"); 
								return callback(map_err , null);
							}else{
								// @FIXME: qui piu elementi possibili!
								document._maps_to_ = [map_ret._id];
								return callback(null ,document);
							}
						});
				}else{
					document.__changed__ = false; /* We will not change the _maps_to_ of the document by default*/
					logToConsole("MAP already existent. UPDATE");
					// @FIXME: we should support multiple element in array!
					mapModel.findById(document._maps_to_[0], function (err, found) {
						if (!found){
							console.log("Map not found ("+document._maps_to_+")");
							callback(new Error("Map not found") , null);
						}else{
							logToConsole("Map found "+document._maps_to_[0])
							// Is this document already present in the map?
							if (_.findIndex(found.children, function(el) { return el.docID == document._id; }) != -1){
								logToConsole("Adding a document already in a map("+document._id+"). Nothing to do here");
								return callback(null ,document);
							}else{
								/* Check the map.value is not already present. If this is the case, return the error */
								if (_.findIndex(found.children, function(el) {return el.value == mapValue; }) != -1){
									logToConsole("Adding a MAP VALUE already in a map("+mapValue+"). Nothing to do here");
									return callback(new Error(mapValue +' already in MAP') , null);
								}else{
									// We should add it!
									found.children.push({value: mapValue /* es. it */ , docID: document._id});
									found.save(function (err) {
										if (!err) {
											document.__changed__ = true ;
											return callback(null ,document);
										} else {
											console.log("Error saving to MAP"); 
											return callback(err , null); 
										}
									});
								}
							} // else
						}
					});
				} // ELSE
			}); // forEach _maps_to_	
	}else{
		logToConsole("Nothing to do HERE for maps")
		// Nothing to do on maps
		return callback(null,document);
	}	 
}


/* 
* Remove a docID from a map.
*/
function removeDocumentFromMap(docID , mapID , callback){
	var mapModel = getModel('Maps');
	mapModel.findById(mapID, function (err, found) {
		if (!found || err){
			console.log("Map not found ("+mapID+")");
			callback(new Error("Map not found in removeDocumentFromMap") , null);
		}else{
			// Where is the element we have to remove?
			var elPos = _.findIndex(found.children, function(doc) { return (doc.docID == docID)});
			// Remove and update
			_.pullAt(found.children , elPos);
			var conditions = { _id: mapID }
  			  , update = { children : found.children};
  			  // Update
			mapModel.update(conditions, update, {}, callback);
		}
	})
} 

/************************
*
*	Useful functions	
*
*************************/

function setEnv(env){
	app.set('env' , env);
	process.env.NODE_ENV = env;
}

/*
* Checks if we know a model named modelName
* @param modelName {string} -  the model name we want to check
* @return {Boolean} - true if we know of a model named modelName
*/
function isKnownModel(modelName){
	return (knownModels.indexOf(modelName) != -1);
}

/*
* Returns the model associated to a name
* @param name {String} - The name of the model
**/
function getModel(name){
	return models[name] || false;
}

/*
* Given the {mapDoc} document (a Map), returns a child mathching the lang {lang}, false/null if no child 
* If more than one children math, return the last one
*/
function childFromMapByLanguage(mapDoc , lang){
	var ret = false;
	if (!mapDoc || !lang)
		return false;
	mapDoc.children.forEach(function(child , index){
		if (child.value == lang)
			ret = child;
	});
	return ret;
}

/*
* Utility function to log to console if we are working in development mode
*/
function logToConsole(obj){
	if (app.get('env') == "development"){
		console.log(colors.red(obj));
	}	
}

/*
* True if map is a defined map
*/
function isAMap(map){
	return (availableMaps.indexOf(map) != -1);
}


/************************
*
*	  AAA functions	
*
*************************/

/*
* Given the req object, checks if the user is already authenticated
* In this simplified version it uses a static token check
* Since with DELETE method we cannot send the token in the body, it is in the url
*/
function authorizedOnly(req , res , next){
	// is a delete request?
	if (req.method == "DELETE"){
		req.body.token = req.params.token;
	}
	if (!req.body.token || (tokens.indexOf(req.body.token) == -1))
			return res.status(401).send({request:"authenticate" , status:-1, err:new Error("Unauthorized")});
	else
		next();
	/* If you need session auth
	if (req.session.isAutenticated)
		next();
	else
		res.status(401).send({request:"authenticate" , status:-1, err:new Error("Unauthorized")});
	*/
}

/*
* signIn a user. 
* Looks in req.body for userName and userPass
*/
function signIn(req , res){
	if (!req.session.isAutenticated)
	req.session.isAutenticated = false;
	if (!req.body.userName || !req.body.userPass){
		return res.status(400).send({request:"signIn" , status:-1, err:new Error("Malformed query")});
	}
	if (!credentials.users[req.body.userName]){
		return res.status(401).send({request:"signIn" , status:-1, err:new Error("Incorrect user or password")});
	}else{
		if (credentials.users[req.body.userName].password == req.body.userPass){
			req.session.isAutenticated = true;
			req.session.userName = req.body.userName;
			req.session.mail = credentials.users[req.body.userName].mail;
			return res.send({request:"signIn" , status:1});
		}else
			return res.status(401).send({request:"signIn" , status:-1, err:new Error("Incorrect user or password")});
	}
}

/*
* signOut a user. 
*/
function signOut(req , res){
	if (!req.session.isAutenticated)
		req.session.isAutenticated = false;
	req.session.destroy(function(err){
		if(err)
			return res.status(500).send({request:"signOut" , status:-1, err:new Error("Error destroying session")});
		return res.send({request:"signOut" , status:1});
	});
}
