# Collects Austin mental-health business listings from the Google Places API (api_key must be supplied by you).
import requests

import json

api_key = '...'

text_search_url = 'https://maps.googleapis.com/maps/api/place/textsearch/json?'

place_details_url = 'https://maps.googleapis.com/maps/api/place/details/json?'


def make_search_request (q: str) -> dict:
    # craft a request
    req = text_search_url
    req += 'query={q}&key={k}'.format(q=q.replace(' ', '%20'), k=api_key)
    print(req)
    # make request
    resp = requests.get(req).json()
    return resp

def parse_phone_number_data (file_name: str) :
    data = json.load(open('../data/places_of_treatment/{f}_parsed.json'.format(f=file_name)))
    for location_name in data :
        file_name = location_name
        location_data = json.load(open('../data/{s}.json'.format(s=file_name)))
        if 'formatted_phone_number' in location_data['result'] :
            data[location_name]['phone_number'] = location_data['result']['formatted_phone_number']
    store_json_in_file(data, '{f}_parsed'.format(f=file_name))

def parse_hours_data (file_name: str) :
    data = json.load(open('../data/places_of_treatment/{f}_parsed.json'.format(f=file_name)))
    for location_name in data :
        file_name = location_name
        location_data = json.load(open('../data/{s}.json'.format(s=file_name)))
        result = location_data['result']
        if len(result) > 0 :
            if 'opening_hours' in result :
                hours_dict = result['opening_hours']
                if 'weekday_text' in hours_dict :
                    hours_text = hours_dict['weekday_text']
                    data[location_name]['hours'] = hours_text
    store_json_in_file(data, '{f}_parsed'.format(f=file_name))

def parse_review_data (file_name: str) :
    data = json.load(open('../data/places_of_treatment/{f}_parsed.json'.format(f=file_name)))
    for location_name in data :
        location_data = json.load(open('../data//places_of_treatment/{s}.json'.format(s=location_name)))
        result = location_data['result']
        if len(result) > 0 :
            if 'reviews' in result :
                print('Received.')
                reviews_dict = result['reviews']
                data[location_name]['reviews'] = reviews_dict
    store_json_in_file(data, '{f}_parsed'.format(f=file_name))

def remove_excess_review_data (file_name: str) :
    data = json.load(open('../data/places_of_treatment/{f}_parsed.json'.format(f=file_name)))
    for location in data :
        if 'reviews' in data[location] :
            review_list = data[location]['reviews']
            for review in review_list :
                if 'language' in review :
                    del review['language']
                if 'original_language' in review :
                    del review['original_language']
                if 'profile_photo_url' in review :
                    del review['profile_photo_url']
                if 'time' in review :
                    del review['time']
                if 'translated' in review :
                    del review['translated']
    store_json_in_file(data, '{f}_parsed'.format(f=file_name))

def get_additional_data (file_name: str, fields = ['reviews']) :
    data = json.load(open('../data/places_of_treatment/{f}_parsed.json'.format(f=file_name)))
    for location_name in data :
        if 'place_id' in data[location_name] :
            id = data[location_name]['place_id']
            location_data = make_place_request(id, fields)
            store_json_in_file(location_data, location_name)

def make_place_request (id: str, fields) -> dict :
    req = place_details_url
    req += 'fields='
    for fi in range(len(fields) - 1) :
        req += fields[fi] + '%2C'
    req += fields[len(fields) - 1]
    req += '&place_id={id}&key={k}'.format(id=id, k=api_key)
    print(req)
    return requests.get(req).json()


def parse_json_data(file_name: str) :
    results = json.load(open('../data/{f}.json'.format(f=file_name)))['results']
    parsed = {}
    print("Size: ", len(results))
    for location in results :
        single_dict = {}
        print("LOCATION")
        print(location)
        if 'formatted_address' in location :
            single_dict['address'] = location['formatted_address']
        if 'photos' in location :
            single_dict['coordinates'] = location['geometry']
        if 'photos' in location :
            single_dict['photo_info'] = location['photos']
        if 'rating' in location :
            single_dict['rating'] = location['rating']
        if 'user_ratings_total' in location :
            single_dict['num_ratings'] = location['user_ratings_total']
        if 'place_id' in location :
            single_dict['place_id'] = location['place_id']
        parsed[location['name']] = single_dict
    print("Size: ", len(parsed))
    store_json_in_file(parsed, '{f}_parsed'.format(f=file_name))

def store_json_in_file(data: dict, name: str) :
    json_obj = json.dumps(data, indent=4)
    if '/' in name:
        name = name.replace('/', ' ')
    with open('../data/places_of_treatment/{n}.json'.format(n=name), 'w') as ofile :
        ofile.write(json_obj)

if __name__ == '__main__' :
    print('Running Google Maps Places API Scraper')
    # creates a new search request of the query and stores it in a file
    # data = make_search_request('Hospitals in Austin')
    # store_json_in_file(data, 'hospitals')

    #data = make_search_request('Borderline personality disorder')
    #print(data)
    #store_json_in_file(data, 'test')

    # parses the data with the name of the file (same as prev)
    # parse_json_data('hospitals')

    #parse_json_data('test')

    # get additional data for each query result (defaults to hours and phone number), parses, and creates a file for each 
    # get_additional_data('urgent_care')
    # parse_hours_data('final')

    # gets phone number data for each query result, and stores in file
    # parse_hours_data('hospitals')
    # parse_phone_number_data('hospitals')
    # parse_review_data('urgent_care')
    # remove_excess_review_data('urgent_care')