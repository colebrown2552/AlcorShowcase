"""Flask REST API for Mental Health Austin.

Serves disorders, treatments and locations from the database configured in
``orm_classes`` (SQLite by default). Run with ``python app.py``; the port comes
from the ``PORT`` environment variable (default 5000) and the server binds to
127.0.0.1 unless `HOST` is set (the Dockerfile sets it).
"""
import os

from flask import Flask
from flask import request
# from flask_sqlalchemy import SQLAlchemy
import random
import sqlalchemy as sqla
import sqlalchemy.orm as orm
# from sqlalchemy.orm import DeclarativeBase

# import sql alchemy classes
import orm_classes as oc

import json

# set up flask app
app = Flask(__name__)
session = None

@app.route('/')
def home():
    """Return an HTML landing page that links to every API endpoint."""
    return ('<p>Welcome! Our project acts as a hub of information for mental health services in Austin.' +
    'We detail various mental illnesses and disorders, along with the places where they may ' +
    'be treated and the types of treatment these places offer. The website raises awareness about' +
    'mental illnesses, both for people who want to learn more and people who want to be treated.\n\n' +
    'This API has endpoints to GET all instances of mental disorders, places of treatment, and ' +
    'treatments stored in the database. Additionally, this API has endpoints to GET specific instances ' + 
    'of these models.</p>' +
    '<A href="/get_all_disorders/">GET All Disorders</A><br><br>' +
    '<A href="/get_all_locations/">GET All Locations</A><br><br>' + 
    '<A href="/get_all_treatments/">GET All Treatments</A><br><br>' +
    '<A href="/get_disorder?causes&description&diagnosis&id&image_url&locations_list&name&symptoms&treatment_attr&treatments_list">GET Disorder</A><br><br>' +
    '<A href="/get_treatment?description&disorders_list&id&locations_list&media&name=&title&treatment_type&url">GET Treatment</A><br><br>' +
    '<A href="/get_location?address&disorders_list&hours&id&latitude&longitude&name&num_ratings&phone_number&photo_info&rating&treatments_list">GET Location</A>')

@app.route('/get_disorder/', methods=['GET'])
def get_disorder():
    """GET /get_disorder/: filter disorders by attribute query parameters (all if none)."""
    if not request.args:
        return get_all_disorders()
    url_params = request.args
    search_params = {}

    attrs = []
    for e in dir(oc.Disorder.Disorder):
        if e[0] != '_' and e != 'metadata' and e != 'treatments_list' and e != 'locations_list':
            attrs.append(e.lower())
    
    for param_name, param in url_params.items():
        if type(param_name) == str and param_name.lower() in attrs:
            search_params[param_name] = param
    
    all_disorders = get_all_disorders()
    res = []
    for disorder in all_disorders:
        for key, value in search_params.items():
            if value.lower() == disorder[key].lower() or value.lower() in disorder[key].lower() or disorder[key].lower() in value.lower()\
                or ((type(value) == float or type(value) == int) and value == disorder[key]):
                res.append(disorder)
                break
    return res

@app.route('/get_all_disorders/', methods=['GET'])
def get_all_disorders():
    """GET /get_all_disorders/: return every disorder as JSON."""
    a = session.query(oc.Disorder.Disorder).all()
    return [sql_alchemy_thing_to_dict(x) for x in a]

@app.route('/get_treatment/', methods=['GET'])
def get_treatment():
    """GET /get_treatment/: filter treatments by attribute query parameters (all if none)."""
    if not request.args:
        return get_all_treatments()

    url_params = request.args
    search_params = {}

    attrs = []
    for e in dir(oc.Treatment.Treatment):
        if e[0] != '_' and e != 'metadata' and e[-4:] != 'list':
            attrs.append(e.lower())
    
    for param_name, param in url_params.items():
        if type(param_name) == str and param_name.lower() in attrs:
            search_params[param_name] = param
    
    a = get_all_treatments()
    res = []
    for i in a:
        for key, value in search_params.items():
            if value.lower() == i[key].lower() or value.lower() in i[key].lower() or i[key].lower() in value.lower()\
                or ((type(value) == float or type(value) == int) and value == i[key]):
                res.append(i)
                break
    return res

@app.route('/get_all_treatments/', methods=['GET'])
def get_all_treatments():
    """GET /get_all_treatments/: return every treatment as JSON."""
    a = session.query(oc.Treatment.Treatment).all()
    return [sql_alchemy_thing_to_dict(x) for x in a]

@app.route('/get_location/', methods=['GET'])
def get_location():
    """GET /get_location/: filter locations by attribute query parameters (all if none)."""
    if not request.args:
        return get_all_locations()

    url_params = request.args
    search_params = {}

    attrs = []
    for e in dir(oc.Location.Location):
        if e[0] != '_' and e != 'metadata' and e[-4:] != 'list':
            attrs.append(e.lower())
    
    for param_name, param in url_params.items():
        if type(param_name) == str and param_name.lower() in attrs:
            try:
                temp = float(param)
            except:
                temp = param
            search_params[param_name] = temp
    
    a = get_all_locations()
    res = []
    for i in a:
        for key, value in search_params.items():
            if type(value) != type(i[key]):
                continue
            if (type(value) == str and (value.lower() == i[key].lower() or value.lower() in i[key].lower() or i[key].lower() in value.lower())) \
                or ((type(value) == float or type(value) == int) and value == i[key]):
                res.append(i)
                break
    return res

@app.route('/get_all_locations/', methods=['GET'])
def get_all_locations():
    """GET /get_all_locations/: return every location as JSON."""
    a = session.query(oc.Location.Location).all()
    return [sql_alchemy_thing_to_dict(x) for x in a]

@app.route('/', methods=['GET'])
def test_connection():
    """Connectivity check (shadowed by the landing page route)."""
    return 'Connection Successful!'

@app.before_request
def before():
    """Open a database session for the incoming request."""
    global session
    session = oc.session_maker()

@app.after_request
def after(response):
    """Close the session, add CORS headers and apply the optional sort_by ordering."""
    global session
    if session:
        session.close()
        oc.engine.dispose()
        session = None
    
    #add ors permissions
    response.headers['Access-Control-Allow-Origin'] = '*'

    # sort
    try:
        sort_by = request.args["sort_by"] if 'sort_by' in request.args else 'name'
        j = response.get_json()
        t = list(j)
        data = sorted(list(response.get_json()), key=lambda x: x[sort_by])
        response.data = json.dumps(data)
    except:
        pass

    return response

allowed_types = [sqla.Integer, sqla.String, sqla.Float, sqla.Double,
                 str, int, float]
def sql_alchemy_thing_to_dict(obj):
    """Convert an ORM row to a JSON-ready dict, splitting '~'-joined *_list columns."""
    final_dict = {}
    error_count = 0
    for o in obj.__dict__.items():
        try:
            key, val = o
            if type(val) in allowed_types:
                if 'list' in key:
                    val = val.split("~")
                final_dict[key] = val
            else:
                pass
        except Exception as error:
            # final_dict[f'error{error_count}'] = error
            pass
    return final_dict


 # For Debugging / Testing

if __name__ == '__main__':
    # setup()
    app.run(host=os.environ.get('HOST', '127.0.0.1'), port=int(os.environ.get('PORT', '5000')))
