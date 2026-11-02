# Scrapes medication and treatment data from the NHS API (sub_key must be supplied by you).
import requests
import json

# get names of illnesses
# with open('./Disorders.jsonl', 'r') as json_file :
#     data = list(json_file)
# for json_str in data :
#     disorders = json.loads(json_str)

def make_sample_request (sub_key: str) -> dict :
    uri = 'https://api.nhs.uk/mental-health/conditions/dissociative-disorders/'
    # make request
    resp = requests.get(uri, headers={'subscription-key' : sub_key})
    return resp.json()

def make_request (sub_key: str, url: str) -> dict:
    # make request
    resp = requests.get(url, headers={'subscription-key' : sub_key})
    return resp.json()

def store_in_file_ (data: dict, extension) :
    with open('nhs_{e}.json'.format(e=extension), 'w') as ofile :
        json.dump(data, fp=ofile, indent=4)

def get_available_meds (data: dict, sub_key: str) :
    med_dict = {}
    medicine_list_data = data['mainEntityOfPage'][1]['mainEntityOfPage']
    # iterate through medicine list
    for i in range(len(medicine_list_data) - 1) :
        med_name = medicine_list_data[i]['headline']
        med_url = medicine_list_data[i]['url'].replace('www', 'api')
        # med_json = make_request(sub_key, med_url)
        med_json = json.load(open('nhs_{e}.json'.format(e=med_name.lower())))
        if len(med_json) == 17:
            med_dict[med_name] = {}
            med_dict[med_name]['name'] = med_name

            description = med_json['hasPart'][0]['hasPart'][0]['text']
            description += med_json['hasPart'][1]['hasPart'][0]['text']
            med_dict[med_name]['description'] = description
        
            disorders = []
            related_disorder_data = med_json['mainEntityOfPage'][1]['mainEntityOfPage']
            for d in range(len(related_disorder_data)) :
                disorder_data = related_disorder_data[d]
                disorder_name = disorder_data['headline']
                disorders.append(disorder_name)
            med_dict[med_name]['disorders'] = disorders
            
            side_effects = med_json['hasPart'][3]['description']
            med_dict[med_name]['side_effects'] = side_effects
    store_in_file_(med_dict, 'medications')

def make_test_request (sub_key: str) -> dict:
    uri = 'https://api.nhs.uk/medicines/sertraline/'
    # make request
    resp = requests.get(uri, headers={'subscription-key' : sub_key})
    return resp.json()

def get_data (data: dict) :
    res_dict = {}
    disorder_name = data.get("name")
    main = data.get("mainEntityOfPage")
    treatment_data = main[6].get("mainEntityOfPage")[0].get("text")
    # get treatment names
    treatment_data = treatment_data.split("<h3>")
    treat_dict = {}
    for t in treatment_data[1:] :
        t = t.split("</h3>")
        t[0] = t[0].replace("<b>", "")
        t[0] = t[0].replace("</b>", "")
        treatment_name = t[0]
        treatment_desc = t[1]
        treat_dict[treatment_name] = treatment_desc
    
    for t in treat_dict :
        res_dict[t] = {"Description" : treat_dict[t], 
                       "Disorders" : disorder_name}
    return res_dict

def store_in_file(data: dict) :
    json_obj = json.dumps(data, indent=4)
    with open('nhs_treatments.json', 'w') as ofile :
        ofile.write(json_obj)

if __name__ == "__main__" :
    # Test
    disorders = ["Social anxiety", "Dissociative identity disorder", "Hypoactive sexual desire disorder"]
    sub_key = '...'
    url = 'https://api.nhs.uk/mental-health/talking-therapies-medicine-treatments/medicines-and-psychiatry/'

    f = open('nhs_test2.json')

    test_data = json.load(f)

    # test_data = make_request(sub_key, url)

    get_available_meds(test_data, sub_key)

    # test2_data = make_test_request(sub_key)

    # store in JSON file
    # with open('nhs_test.json', 'w') as ofile :
    #     json.dump(data, fp=ofile, indent=4)

    # with open('nhs_test2.json', 'w') as ofile :
    #     json.dump(test_data, fp=ofile, indent=4)

    # with open('nhs_test3.json', 'w') as ofile :
    #     json.dump(test2_data, fp=ofile, indent=4)
    
    # res_dict = get_data(data)
    # store_in_file(res_dict)
