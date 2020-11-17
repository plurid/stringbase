the locator is of shape

    collection.document|collection

after a document only a collection can follow


a document is located by key and value

the `key` can be

+ equal to a value `key:value`
+ less than a value `key<value`
+ greater than a value `key>value`


examples

    records.id:123      // from the collection records,
                        // get the documents with id equal to 123

    records.createdAt<1605645987    // from the collection records,
                                    // get the documents createdAt before 1605645987

for ease of use, spaces/new lines can be inserted

    records
        . createdAt < 1605645987


considering a nested object inside the document, it can be located as such

    records.{notifyAt.events.login}:true

    or spaced

    records
        . {
            notifyAt
            .events
            .login
        } : true


    this locator will get all the records where the document field `notifyAt.events.login` is true



dynamic locators can be used, instead of the value, another key based can be used


    records
        . {
            notifyAt
            .events
            .login
        } : {
            .notifyAt
            .events
            .logout
        }

    this locator will get all the records where the document field notifyAt.events.login
    is equal with the notifyAt.events.logout field

    if the leading dot is used it will look inside the document, if not, it will start at the root of the database

    records
        . {
            notifyAt
            .events
            .login
        } : {
            logs
            .notifyAt
            .events
            .logout
        }

    is a valid locator matching between two collections


    records
        . id:123 & id:124   - and

    records
        . id:123 | id:124    - or

    records
        . id!:123   - not equal



cursor handling


    records
        . ownedBy:123

    // gets all the records of owner 123

    which is tantamount to

    records
        . ownedBy:123 |all|


    records
        . ownedBy:123 |first 5|

    // gets the first 5 records of owner 123


    records
        . ownedBy:123 |last 5|

    // gets the last 5 records of owner 123


    records
        . ownedBy:123 |5 above 456|

    // gets 5 records above the cursor id 456


    records
        . ownedBy:123 |5 below 456|

    // gets 5 records below the cursor id 456
