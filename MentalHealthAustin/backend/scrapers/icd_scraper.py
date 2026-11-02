# Queries the WHO ICD API for disorder entities (client_id/client_secret must be supplied by you).
import requests

import json

token_endpoint = 'https://icdaccessmanagement.who.int/connect/token'
client_id = '...'
client_secret = '...'
scope = 'icdapi_access'
grant_type = 'client_credentials'

# set data
payload = {'client_id' : client_id, 
           'client_secret' : client_secret, 
           'scope' : scope, 
           'grant_type' : grant_type}

# make token request
req = requests.post(token_endpoint, data=payload, verify=False).json()
token = req['access_token']

# access ICD API
uri = 'https://id.who.int/icd/entity'

headers = {'Authorization' : 'Bearer ' + token,
           'Accept' : 'applications/json',
           'Accept-Language' : 'en',
           'API-Version' : 'v2'}

# make request
resp = requests.get(uri, headers=headers, verify=False)

# store in JSON file
with open('icd.json', 'w') as ofile :
    json.dump(resp.json(), fp=ofile, indent=4)

# documentation: https://id.who.int/swagger/index.html