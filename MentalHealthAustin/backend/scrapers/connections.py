# Links disorders, treatments and locations together by name to build the *FinalConnections.json data files.
import json

import gmaps_scraper

def getDisorders():
    file_path = '../data/Disorders.jsonl'
    disorders_list = []

    with open(file_path, 'r') as file:
        for line in file:
            entry_data = json.loads(line)
            disorders_list.append(entry_data)
    
    return disorders_list
    '''
    for value in entry_data.values():
        for specific in value.values():
            print(specific)
            print("\n" + "="*50 + "\n")
        print("\n" + "="*50 + "\n")
        print("\n" + "="*50 + "\n")
        print("\n" + "="*50 + "\n")
    '''

"""
def getMedications():
    file_path = '../data/nhs_medications.json'

    with open(file_path, 'r') as file:
        data = json.load(file)
        for value in data.values():
            for specific in value.values():
                print(specific)
                print("\n" + "="*50 + "\n")
"""


def getTreatments():
    file_path = '../data/Treatments.json'

    with open(file_path, 'r') as file:
        data = json.load(file)
        return data

        '''
        for value in data:
            for specific in value.values():
                print(specific)
                print("\n" + "="*50 + "\n")
            print("\n" + "="*50 + "\n")
            print("\n" + "="*50 + "\n")
            print("\n" + "="*50 + "\n")
        '''

def buildTreatmentDisorder():
    treatmentData = getTreatments()
    disorderData = getDisorders()

    '''
    for value in disorderData.values():
        for specific in value.values():
            print(specific)
    '''

    for treatment in treatmentData:
        for disorderConnection in treatment['Disorders']:
            for value in disorderData:
                first_key = list(value.keys())[0]
                if first_key.lower() == disorderConnection.lower():
                    first_value = next(iter(value.values()))
                    if 'Treatments' not in first_value: 
                        first_value['Treatments'] = [treatment['title']]
                    else:
                        first_value['Treatments'].append(treatment['title'])
                    break

    file_path = '../data/connections/disorderConnections.json'

    with open(file_path, 'w') as json_file:
        json.dump(disorderData, json_file, indent=4)

def parse_json_data(results):
    parsed = {}
    #print("Size: ", len(results))
    for location in results :
        single_dict = {}
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
    #print("Size: ", len(parsed))
    return parsed

def buildLocationDisorder():
    file_path = '../data/connections/disorderConnections.json'
    locationData = {}

    with open(file_path, 'r') as file:
        disorderData = json.load(file)

    #extra
    file_path = '../data/places_of_treatment/mental_health_locations_parsed.json'
    with open(file_path, 'r') as file:
        mentalHealthData = json.load(file)
    
    for disorder in disorderData:
        disorderName = list(disorder.keys())[0]
        data = gmaps_scraper.make_search_request(disorderName)
        data = parse_json_data(data['results'])
        first_value = next(iter(disorder.values()))

        for location in data:
            if 'Locations' not in first_value: 
                first_value['Locations'] = [location]
            else:
                first_value['Locations'].append(location)
        
        #extra
        counter = 0
        for location in mentalHealthData:
            if (counter > 2):
                break
            if 'Locations' not in first_value: 
                first_value['Locations'] = [location]
            elif location not in first_value['Locations']:
                first_value['Locations'].append(location)
            counter += 1

        for key in data.keys():
            if key in locationData.keys():
                locationData[key]['Disorders'].append(disorderName)
            else: 
                obj = data[key]
                obj['Disorders'] = [disorderName]
                locationData[key] = obj
            if 'Treatments' not in locationData[key]:
                if 'Treatments' in first_value:
                    locationData[key]['Treatments'] = first_value['Treatments']
            else:
                if 'Treatments' in first_value:
                    for item in first_value['Treatments']:
                        if item not in locationData[key]['Treatments']:
                            locationData[key]['Treatments'].append(item)

        #extra
        counter = 0
        for key in mentalHealthData.keys():
            if (counter > 2):
                break
            if key in locationData.keys():
                locationData[key]['Disorders'].append(disorderName)
            else: 
                obj = mentalHealthData[key]
                obj['Disorders'] = [disorderName]
                locationData[key] = obj
            if 'Treatments' not in locationData[key]:
                if 'Treatments' in first_value:
                    locationData[key]['Treatments'] = first_value['Treatments']
            else:
                if 'Treatments' in first_value:
                    for item in first_value['Treatments']:
                        if item not in locationData[key]['Treatments']:
                            locationData[key]['Treatments'].append(item)
            counter += 1

    # Specify the file path
    file_path = '../data/connections/disorderFinalConnections.json'

    # Write the list of JSON objects to the file
    with open(file_path, 'w') as json_file:
        json.dump(disorderData, json_file, indent=4)
    
    file_path = '../data/connections/locationFinalConnections.json'

    # Write the list of JSON objects to the file
    with open(file_path, 'w') as json_file:
        json.dump(locationData, json_file, indent=4)

def buildLocationTreatment():
    treatmentData = getTreatments()
    file_path = '../data/connections/disorderFinalConnections.json'
    with open(file_path, 'r') as file:
        disorderData = json.load(file)

    for treatment in treatmentData:
        for disorderConnection in treatment['Disorders']:
            for value in disorderData:
                first_key = list(value.keys())[0]
                if first_key.lower() == disorderConnection.lower():
                    first_value = next(iter(value.values()))
                    if 'Locations' in first_value: 
                        for location in first_value['Locations']:
                            if 'Locations' not in treatment: 
                                treatment['Locations'] = [location]
                            elif location not in treatment['Locations']:
                                treatment['Locations'].append(location)
                    break 
    
    # Specify the file path
    file_path = '../data/connections/treatmentFinalConnections.json'

    # Write the list of JSON objects to the file
    with open(file_path, 'w') as json_file:
        json.dump(treatmentData, json_file, indent=4)

if __name__ == "__main__" :
    # buildTreatmentDisorder()
    
    #data = gmaps_scraper.make_search_request('Borderline personality disorder')
    #data = parse_json_data(data['results'])

    buildLocationTreatment()

    #print(data)
