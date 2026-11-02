# Scrapes drug names, classes and labels from the public DailyMed web services.
import requests
import json
import xml
import lxml
import xml.etree.ElementTree as ET
import os
import re


from bs4 import BeautifulSoup




url = 'https://dailymed.nlm.nih.gov/dailymed/services'
numOfVaildTreatments = 1

disorders = ['Sleep', 'Dysphoria']

final_treatments = []

def query_dailymed (resource_name, format='json') -> str :
    req = '{u}/v2/{r}.{f}'.format(u=url, r=resource_name, f=format)
    resp = requests.get(req)

    with open('dailymed_{r}.{f}'.format(r=resource_name, f=format), 'w') as ofile :
        json.dump(resp.json(), fp=ofile, indent=4)


def gather_disorder () :
    with open('backend\data\Disorders.jsonl', 'r') as file:
        json_list = list(file)
    for json_str in json_list:
        result = json.loads(json_str)
        currDisorder = [key for key in result.keys()][0]
        global disorders
        if ((currDisorder != 'Non-24-hour sleep–wake disorder') & (currDisorder != 'Sleepwalking') & (currDisorder != 'Rapid eye movement sleep behavior disorder') & (currDisorder != 'Body integrity dysphoria') & (currDisorder != 'Gender dysphoria')) :
            disorders.append(str(currDisorder)) 
    print(disorders)

def add_disorder (root, currTreatment) :
    for item in root :
        if (item.text is not None) :
            holdText = item.text
            for i in disorders :
                res = re.search(r'\W+', i + '!').start()
                res = i[0 : res]
                if ((res in holdText) & (i not in currTreatment['Disorders'])) :
                    if ((i == 'Sleep') & ('Sleepwalking' not in currTreatment['Disorders'])) :
                        currTreatment['Disorders'].append('Non-24-hour sleep–wake disorder')
                        currTreatment['Disorders'].append('Sleepwalking')
                        currTreatment['Disorders'].append('Rapid eye movement sleep behavior disorder')
                    elif ((i == 'Dysphoria') & ('Gender dysphoria' not in currTreatment['Disorders'])):
                        currTreatment['Disorders'].append('Gender dysphoria')
                        currTreatment['Disorders'].append('Body integrity dysphoria')
                    else :
                        currTreatment['Disorders'].append(i)
                    print(i)
        add_disorder (item, currTreatment)
    

def query_dailymed_spls (resource_name, page_num, format='json') -> str :
    req = '{u}/v2/{r}.{f}?page={p}'.format(u=url, r=resource_name, p = page_num, f=format)
    resp = requests.get(req)

    with open('dailymed_{r}.{f}'.format(r=resource_name, f=format), 'w') as ofile :
        json.dump(resp.json(), fp=ofile, indent=4)


def query_dailymed_sids(resource_name, setID, format='xml') -> xml.etree.ElementTree.ElementTree :
    req = '{u}/v2/{r}/{s}.{f}'.format(u=url, r=resource_name, s=setID, f=format)
    resp = requests.get(req)

    file = 'dailymed_{s}.{f}'.format(s=setID, f=format)
    with open("fileTEMP", 'wb') as f:
        f.write(resp.content)

    if os.path.exists("fileTEMP") and os.path.getsize("fileTEMP") > 0:
        tree = ET.parse('fileTEMP')
        return tree
    return None

def query_dailymed_media (resource_name, setID, media = 'media', format = 'json') -> str:
    req = '{u}/v2/{r}/{s}/{m}.{f}'.format(u=url, r=resource_name, s = setID, m = media, f=format)
    resp = requests.get(req)

    file = 'dailymed_{r}_{m}.{f}'.format(r=resource_name, m = 'media', f=format)
    with open(file, 'w') as ofile :
        json.dump(resp.json(), fp=ofile, indent=4)

    with open(file, 'r') as file:
        data = json.load(file)


    return data['data']['media'][0]['url']

def query_dailymed_short_name (root, currTreatment) :
    for item in root :
        langSplit = item.tag.split("}")
        if ('component' in langSplit) :
            item = item[0][0][0]
            index = len(item)
            for child in item :
                langSplit = child.tag.split("}")
                if ('subject' in langSplit) :
                    child = child[0][0][1]
                    if (child.text is not None) :
                        res = re.search(r'\W+', child.text + '!').start()
                        res = child.text[0 : res]
                    currTreatment['name'] = str(res)
                    print(child.text)
            
    return None

def wiki_name (search) :

    url = 'https://en.wikipedia.org/w/api.php?action=opensearch&format=json&search='
    format = '&formatversion=2'
    req = '{u}{s}{f}'.format(u=url, s = search, f=format)
    resp = requests.get(req)

    with open('wikiData', 'w') as ofile :
        json.dump(resp.json(), fp=ofile, indent=4)

    with open('wikiData', 'r') as file:
        data = json.load(file)

    if (type(data) == dict) :
        return None
    if (data[1]) :
        return data[1][0]
    else :
        return None

def wiki_desc (search) -> str:
    url = 'https://en.wikipedia.org/w/api.php?action=opensearch&search='
    format = '&prop=extracts&format=json&exintro=1'
    req = '{u}{s}{f}'.format(u=url, s = search, f=format)
    resp = requests.get('https://en.wikipedia.org/w/api.php?format=json&action=query&prop=extracts&exintro&explaintext&redirects=1&titles=' + search)

    with open('wikiDataDes', 'w') as ofile :
        json.dump(resp.json(), fp=ofile, indent=4)

    with open('wikiDataDes', 'r') as file:
        data = json.load(file)

    for keys in data['query']['pages'] :
        return data['query']['pages'][keys]['extract']
    
def query_dailymed_desc (root, currTreatment) :

    for item in root :
        langSplit = item.tag.split("}")
        if ('component' in langSplit) :
            item = item[0][0][0]
            index = len(item)
            for child in item :
                langSplit = child.tag.split("}")
                if ('subject' in langSplit) :
                    temp = child[0][0][1]
                    if (temp.text is not None) :
                        res = re.search(r'\W+', temp.text + '!').start()
                        res = temp.text[0 : res]
                        if (wiki_name(res) is not None) :
                            currTreatment['Description'] = wiki_desc(wiki_name(res))
                    currTreatment['name'] = str(res)
                    temp = child[0][0][3][0][0]
                    if ((temp.text is not None) | ((bool)(currTreatment['Description']))) :
                        res = re.search(r'\W+', temp.text + '!').start()
                        res = temp.text[0 : res]
                        if (wiki_name(res) is not None) :
                            return wiki_desc(wiki_name(res))
                    print(temp.text)
    return None
            

def convert_spls_sids (indexed) :
    with open('dailymed_spls.json', 'r') as file:
        data = json.load(file)

    index = 1;
    #print(len(data['data']))
    for i in data['data'] :
        index = index + 1
        tree = query_dailymed_sids('spls', i['setid'])
        if (tree == None) :
            break
        #print(type(i))
        del i["spl_version"]
        del i["published_date"]
        # query_dailymed_sids_title('spls', i['setid'])
        tree = query_dailymed_sids('spls', i['setid'])
        root = tree.getroot()
        
        # if (checkTreatment in disorders) :
        #     print("WASSUP")
        i['media'] = query_dailymed_media('spls', i['setid'])
        i['url'] = 'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid='+i['setid']
        i['Type'] = 'Pharmaceutical'
        i['Disorders'] = []
        i['Description'] =   []
        query_dailymed_desc(root, i)
        add_disorder (root, i)
        query_dailymed_short_name (root, i)
        print(index)
        if (index == 90) :
            break
        
    
    newData = json.dumps(data, indent=4)
        
    with open('Treatments.json', 'w') as file:
        file.write(newData)

def cleanFile () :
    global final_treatments
    newData = json.dumps(final_treatments, indent=4)

    with open('Treatments.json', 'w') as file:
        file.write(newData)

    global disorders
    disorders.remove('Sleep')
    disorders.remove('Dysphoria')

def add_treatments () :
    with open('Treatments.json', 'r') as file:
        data = json.load(file)
    index = 1;
    a = []
    for i in data['data'] :
        index = index + 1
        if ((i["Disorders"])) :
            global numOfVaildTreatments
            numOfVaildTreatments = numOfVaildTreatments + 1
            a.append(i)
            global final_treatments
            final_treatments.append(i)
        if (index == 90) :
            break
    

    insert = {'data' : a}
    newData = json.dumps(insert, indent=4)
    with open('Treatments.json', 'w') as file:
        file.write(newData)

if __name__ == "__main__" :
    index = 1
    gather_disorder ()
    # while (index < 20) :
    #     query_dailymed_spls ('spls', index)
    #     convert_spls_sids(index)
    #     add_treatments()
        
    #     index = index + 1
    # cleanFile()








